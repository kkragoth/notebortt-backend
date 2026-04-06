import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type WebSocket from 'ws'
import type Redis from 'ioredis'
import type { Database } from '../db/client.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'
import { parseClientMessage, serialize } from './messages.js'
import type { BoardRoomManager } from './room.js'
import { getUserColor } from './room.js'
import type { HeartbeatService } from './heartbeat.js'
import { createBoardMutationPubSub } from './pubsub.js'
import { extractWsContext, isRateLimited, sendInitialState, type RateLimitState } from './handler.utils.js'

const RATE_LIMIT_MAX_PER_SECOND = 30
const PRESENCE_RATE_LIMIT_MAX_PER_SECOND = 20
const ROOM_FLUSH_GRACE_PERIOD_MS = 30_000

export function createWebSocketHandler(
  roomManager: BoardRoomManager,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
  heartbeat: HeartbeatService,
  db: Database,
  pubRedis: Redis,
) {
  const mutationPubSub = createBoardMutationPubSub(pubRedis, roomManager)
  const gracePeriodTimers = new Map<string, NodeJS.Timeout>()

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
      mutationPubSub.unsubscribeFromBoard(boardId)
      console.log(`[WS] Flushed board ${boardId} from Redis after grace period`)
    }, ROOM_FLUSH_GRACE_PERIOD_MS)
    gracePeriodTimers.set(boardId, timer)
  }

  function sendExistingRoomMembers(ws: WebSocket, boardId: string, excludeConnectionId: string): void {
    const members = roomManager.getRoom(boardId)
    for (const member of members) {
      if (member.connectionId === excludeConnectionId) continue
      ws.send(serialize({
        type: 'USER_JOINED',
        userId: member.userId,
        userName: member.userName,
        avatarUrl: member.avatarUrl ?? null,
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

    const { boardId, userId, userName, avatarUrl, lastSequence } = context
    const connectionId = randomUUID()
    const color = getUserColor(userId)

    cancelGracePeriod(boardId)
    mutationPubSub.ensureSubscribedToBoard(boardId)

    await boardStateService.loadBoard(boardId)
    await boardStateService.trackClient(boardId, userId, connectionId)

    const client = { ws, userId, userName, avatarUrl, connectionId, color, lastPong: Date.now() }
    sendExistingRoomMembers(ws, boardId, connectionId)
    roomManager.joinRoom(boardId, client)

    await sendInitialState(ws, boardId, lastSequence, db, boardStateService, pubRedis)

    const mutationRateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }
    const presenceRateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }

    ws.on('message', async (raw: Buffer) => {
      const message = parseClientMessage(raw.toString())
      if (!message) return

      if (message.type === 'MUTATION') {
        if (isRateLimited(mutationRateLimitState, RATE_LIMIT_MAX_PER_SECOND)) {
          ws.send(serialize({ type: 'RATE_LIMITED' }))
          return
        }

        if (message.mutation.operation.type === 'MOVE_ELEMENTS' && message.mutation.operation.transient) {
          roomManager.broadcastToRoom(boardId, {
            type: 'MUTATION',
            mutation: message.mutation,
            fromUserId: userId,
          }, connectionId)

          await mutationPubSub.publishMutation(boardId, message.mutation, userId, connectionId)
          ws.send(serialize({
            type: 'MUTATION_RESULT',
            result: {
              mutationId: message.mutation.mutationId,
              status: 'broadcast_only',
              serverTimestamp: Date.now(),
            },
          }))
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

          await mutationPubSub.publishMutation(boardId, message.mutation, userId, connectionId)
        }
        return
      }

      if (message.type === 'PRESENCE') {
        if (isRateLimited(presenceRateLimitState, PRESENCE_RATE_LIMIT_MAX_PER_SECOND)) {
          return
        }

        roomManager.broadcastToRoom(boardId, {
          type: 'PRESENCE',
          userId,
          cursor: message.cursor,
          selectedIds: message.selectedIds ?? [],
          userName,
          avatarUrl,
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
