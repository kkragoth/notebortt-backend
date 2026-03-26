import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type WebSocket from 'ws'
import { and, asc, eq, gt } from 'drizzle-orm'
import type Redis from 'ioredis'
import type { Database } from '../db/client.js'
import { mutations as mutationsTable } from '../db/schema.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'
import { parseClientMessage, serialize } from './messages.js'
import type { MutationCatchUp } from './messages.js'
import type { BoardRoomManager } from './room.js'
import { getUserColor } from './room.js'
import type { HeartbeatService } from './heartbeat.js'
import type { UpgradeContext } from './upgrade.js'

const RATE_LIMIT_MAX_PER_SECOND = 30
const ROOM_FLUSH_GRACE_PERIOD_MS = 30_000
const REDIS_MUTATION_CHANNEL_PREFIX = 'board:'
const REDIS_MUTATION_CHANNEL_SUFFIX = ':mutations'

function boardMutationChannel(boardId: string): string {
  return `${REDIS_MUTATION_CHANNEL_PREFIX}${boardId}${REDIS_MUTATION_CHANNEL_SUFFIX}`
}

interface RateLimitState {
  count: number
  windowStart: number
}

function isRateLimited(state: RateLimitState): boolean {
  const now = Date.now()
  const windowElapsed = now - state.windowStart
  if (windowElapsed >= 1000) {
    state.count = 0
    state.windowStart = now
  }
  state.count++
  return state.count > RATE_LIMIT_MAX_PER_SECOND
}

function extractWsContext(request: IncomingMessage): UpgradeContext | null {
  return (request as any).__wsContext ?? null
}

async function queryCatchUpMutations(
  db: Database,
  boardId: string,
  afterSequence: number,
): Promise<MutationCatchUp[]> {
  const rows = await db
    .select()
    .from(mutationsTable)
    .where(and(eq(mutationsTable.boardId, boardId), gt(mutationsTable.sequence, afterSequence)))
    .orderBy(asc(mutationsTable.sequence))

  return rows.map((row) => ({
    mutation: {
      mutationId: row.id,
      boardId: row.boardId,
      clientTimestamp: row.clientTs.getTime(),
      serverTimestamp: row.serverTs ? new Date(row.serverTs).getTime() : undefined,
      sequence: row.sequence,
      operation: row.operationData as any,
    },
    sequence: row.sequence,
    serverTimestamp: row.serverTs ? new Date(row.serverTs).getTime() : Date.now(),
  }))
}

export function createWebSocketHandler(
  roomManager: BoardRoomManager,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
  heartbeat: HeartbeatService,
  db: Database,
  pubRedis: Redis,
) {
  const subRedis = pubRedis.duplicate()

  const subscribedBoards = new Set<string>()
  const gracePeriodTimers = new Map<string, NodeJS.Timeout>()

  subRedis.on('message', (channel: string, message: string) => {
    const boardId = extractBoardIdFromChannel(channel)
    if (!boardId) return
    const parsed = tryParseJson(message)
    if (!parsed) return
    const { mutation, fromUserId, senderConnectionId } = parsed
    roomManager.broadcastToRoom(boardId, { type: 'MUTATION', mutation, fromUserId }, senderConnectionId)
  })

  function extractBoardIdFromChannel(channel: string): string | null {
    const prefix = REDIS_MUTATION_CHANNEL_PREFIX
    const suffix = REDIS_MUTATION_CHANNEL_SUFFIX
    if (!channel.startsWith(prefix) || !channel.endsWith(suffix)) return null
    return channel.slice(prefix.length, channel.length - suffix.length)
  }

  function tryParseJson(raw: string): any | null {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  function ensureSubscribedToBoard(boardId: string): void {
    if (subscribedBoards.has(boardId)) return
    subscribedBoards.add(boardId)
    subRedis.subscribe(boardMutationChannel(boardId))
  }

  function unsubscribeFromBoard(boardId: string): void {
    subscribedBoards.delete(boardId)
    subRedis.unsubscribe(boardMutationChannel(boardId))
  }

  function cancelGracePeriod(boardId: string): void {
    const timer = gracePeriodTimers.get(boardId)
    if (timer) {
      clearTimeout(timer)
      gracePeriodTimers.delete(boardId)
    }
  }

  function scheduleRoomFlush(boardId: string): void {
    cancelGracePeriod(boardId)
    const timer = setTimeout(async () => {
      gracePeriodTimers.delete(boardId)
      const roomSize = roomManager.getRoomSize(boardId)
      if (roomSize > 0) return
      await boardStateService.flushBoard(boardId)
      unsubscribeFromBoard(boardId)
      console.log(`[WS] Flushed board ${boardId} from Redis after grace period`)
    }, ROOM_FLUSH_GRACE_PERIOD_MS)
    gracePeriodTimers.set(boardId, timer)
  }

  async function sendInitialState(
    ws: WebSocket,
    boardId: string,
    lastSequence: number,
  ): Promise<void> {
    if (lastSequence === 0) {
      await sendSnapshot(ws, boardId)
      return
    }

    const catchUpMutations = await queryCatchUpMutations(db, boardId, lastSequence)
    if (catchUpMutations.length > 0) {
      ws.send(serialize({ type: 'CATCH_UP', mutations: catchUpMutations }))
    } else {
      await sendSnapshot(ws, boardId)
    }
  }

  async function sendSnapshot(ws: WebSocket, boardId: string): Promise<void> {
    const elements = await boardStateService.getElements(boardId)
    const currentSeqRaw = await pubRedis.get(`board:${boardId}:seq`)
    const currentSeq = currentSeqRaw ? parseInt(currentSeqRaw, 10) : 0
    ws.send(serialize({ type: 'SNAPSHOT', elements, lastSequence: currentSeq }))
  }

  function sendExistingRoomMembers(ws: WebSocket, boardId: string, excludeConnectionId: string): void {
    const members = roomManager.getRoom(boardId)
    for (const member of members) {
      if (member.connectionId === excludeConnectionId) continue
      ws.send(serialize({
        type: 'USER_JOINED',
        userId: member.userId,
        userName: member.userName,
        color: member.color,
      }))
    }
  }

  async function onConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const context = extractWsContext(request)
    if (!context) {
      ws.close(4401, 'Missing upgrade context')
      return
    }

    const { boardId, userId, userName, lastSequence } = context
    const connectionId = randomUUID()
    const color = getUserColor(userId)

    cancelGracePeriod(boardId)
    ensureSubscribedToBoard(boardId)

    await boardStateService.loadBoard(boardId)
    await boardStateService.trackClient(boardId, userId, connectionId)

    const client = { ws, userId, userName, connectionId, color, lastPong: Date.now() }
    sendExistingRoomMembers(ws, boardId, connectionId)
    roomManager.joinRoom(boardId, client)

    await sendInitialState(ws, boardId, lastSequence)

    const rateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }

    ws.on('message', async (raw: Buffer) => {
      const message = parseClientMessage(raw.toString())
      if (!message) return

      if (message.type === 'MUTATION') {
        if (isRateLimited(rateLimitState)) {
          ws.send(serialize({ type: 'RATE_LIMITED' }))
          return
        }

        const result = await mutationProcessor.processMutation(message.mutation, userId)
        ws.send(serialize({ type: 'MUTATION_RESULT', result }))

        if (result.status === 'applied') {
          roomManager.broadcastToRoom(boardId, {
            type: 'MUTATION',
            mutation: message.mutation,
            fromUserId: userId,
          }, connectionId)

          const pubPayload = JSON.stringify({
            mutation: message.mutation,
            fromUserId: userId,
            senderConnectionId: connectionId,
          })
          await pubRedis.publish(boardMutationChannel(boardId), pubPayload)
        }
        return
      }

      if (message.type === 'PRESENCE') {
        console.log('[WS] PRESENCE in:', JSON.stringify({ cursor: message.cursor, selectedIds: message.selectedIds }))
        roomManager.broadcastToRoom(boardId, {
          type: 'PRESENCE',
          userId,
          cursor: message.cursor,
          selectedIds: message.selectedIds ?? [],
          userName,
          avatarUrl: null,
          color,
        }, connectionId)
        return
      }

      if (message.type === 'PONG') {
        heartbeat.handlePong(boardId, connectionId)
        return
      }
    })

    ws.on('close', async () => {
      roomManager.leaveRoom(boardId, connectionId)
      await boardStateService.removeClient(boardId, userId, connectionId)

      const roomSize = roomManager.getRoomSize(boardId)
      if (roomSize === 0) {
        scheduleRoomFlush(boardId)
      }
    })
  }

  return { onConnection }
}

export type WebSocketHandler = ReturnType<typeof createWebSocketHandler>
