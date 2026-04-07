import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type WebSocket from 'ws'
import type Redis from 'ioredis'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'
import type { Mutation } from '../mutations/types.js'
import { parseClientMessage, serialize } from './messages.js'
import type { BoardRoomManager } from './room.js'
import { getUserColor } from './room.js'
import type { HeartbeatService } from './heartbeat.js'
import { createBoardMutationPubSub } from './pubsub.js'
import { extractWsContext, isBoardGloballyIdle, isRateLimited, sendInitialState, type RateLimitState } from './handler.utils.js'

const RATE_LIMIT_MAX_PER_SECOND = 30
const PRESENCE_RATE_LIMIT_MAX_PER_SECOND = 20
const ROOM_FLUSH_GRACE_PERIOD_MS = 30_000
const MUTATION_BATCH_WINDOW_MS = 12
const MUTATION_BATCH_MAX_SIZE = 25

interface PendingMutationBatch {
  mutations: Mutation[]
  flushTimer: NodeJS.Timeout | null
  flushing: boolean
}

interface FlushBatchOptions {
  sendAcks: boolean
}

export function createWebSocketHandler(
  roomManager: BoardRoomManager,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
  heartbeat: HeartbeatService,
  pubRedis: Redis,
) {
  const mutationPubSub = createBoardMutationPubSub(pubRedis, roomManager)
  const gracePeriodTimers = new Map<string, NodeJS.Timeout>()
  const pendingMutationBatches = new Map<string, PendingMutationBatch>()

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
      if (!(await isBoardGloballyIdle(boardId, boardStateService))) return
      await boardStateService.persistBoard(boardId)
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
        sessionId: member.sessionId,
        userId: member.userId,
        userName: member.userName,
        avatarUrl: member.avatarUrl ?? null,
        color: member.color,
      }))
    }
  }

  function getOrCreateBatch(connectionId: string): PendingMutationBatch {
    const existing = pendingMutationBatches.get(connectionId)
    if (existing) {
      return existing
    }

    const created: PendingMutationBatch = {
      mutations: [],
      flushTimer: null,
      flushing: false,
    }
    pendingMutationBatches.set(connectionId, created)
    return created
  }

  async function publishAppliedChanges(
    boardId: string,
    userId: string,
    connectionId: string,
    results: Awaited<ReturnType<MutationProcessor['processBatch']>>,
  ): Promise<void> {
    for (const result of results) {
      if (result.status !== 'applied' || !result.change) {
        continue
      }

      await mutationPubSub.publishMessage(boardId, {
        type: 'ELEMENTS_CHANGED',
        fromUserId: userId,
        change: result.change,
      }, connectionId)
    }
  }

  async function flushMutationBatch(
    boardId: string,
    userId: string,
    connectionId: string,
    ws: WebSocket,
    options: FlushBatchOptions = { sendAcks: true },
  ): Promise<void> {
    const batchState = pendingMutationBatches.get(connectionId)
    if (!batchState || batchState.flushing || batchState.mutations.length === 0) {
      return
    }

    if (batchState.flushTimer) {
      clearTimeout(batchState.flushTimer)
      batchState.flushTimer = null
    }

    batchState.flushing = true
    const batch = batchState.mutations.splice(0, batchState.mutations.length)

    try {
      const results = await mutationProcessor.processBatch(batch, userId)
      if (options.sendAcks && ws.readyState === 1) {
        for (const result of results) {
          ws.send(serialize({ type: 'MUTATION_RESULT', result }))
        }
      }

      await publishAppliedChanges(boardId, userId, connectionId, results)
    } finally {
      batchState.flushing = false
      if (batchState.mutations.length > 0) {
        batchState.flushTimer = setTimeout(() => {
          void flushMutationBatch(boardId, userId, connectionId, ws, options)
        }, MUTATION_BATCH_WINDOW_MS)
      }
    }
  }

  function enqueueMutation(
    boardId: string,
    userId: string,
    connectionId: string,
    ws: WebSocket,
    mutation: Mutation,
  ): void {
    const batchState = getOrCreateBatch(connectionId)
    batchState.mutations.push(mutation)

    if (batchState.mutations.length >= MUTATION_BATCH_MAX_SIZE) {
      void flushMutationBatch(boardId, userId, connectionId, ws)
      return
    }

    if (batchState.flushTimer) {
      return
    }

    batchState.flushTimer = setTimeout(() => {
      batchState.flushTimer = null
      void flushMutationBatch(boardId, userId, connectionId, ws)
    }, MUTATION_BATCH_WINDOW_MS)
  }

  async function refreshConnectionActivity(
    boardId: string,
    userId: string,
    sessionId: string,
    connectionId: string,
  ): Promise<void> {
    await boardStateService.touchViewerSession(boardId, sessionId)
    await boardStateService.trackClient(boardId, userId, connectionId)
    heartbeat.handleActivity(boardId, connectionId)
  }

  async function onConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const context = extractWsContext(request)
    if (!context) {
      ws.close(4401, 'Missing upgrade context')
      return
    }

    const { boardId, userId, userName, avatarUrl, lastSequence, sessionId } = context
    const connectionId = randomUUID()
    const color = getUserColor(userId)

    cancelGracePeriod(boardId)
    mutationPubSub.ensureSubscribedToBoard(boardId)

    await boardStateService.loadBoard(boardId)
    await boardStateService.trackClient(boardId, userId, connectionId)
    await boardStateService.touchViewerSession(boardId, sessionId)

    const client = { ws, sessionId, userId, userName, avatarUrl, connectionId, color, lastPong: Date.now() }
    const replacedClient = roomManager.joinRoom(boardId, client)
    if (replacedClient) {
      await boardStateService.removeClient(boardId, replacedClient.userId, replacedClient.connectionId)
      replacedClient.ws.close(4001, 'Session replaced')
    }
    sendExistingRoomMembers(ws, boardId, connectionId)

    await sendInitialState(ws, boardId, lastSequence, boardStateService, pubRedis)

    const mutationRateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }
    const presenceRateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }

    ws.on('message', async (raw: Buffer) => {
      try {
        const message = parseClientMessage(raw.toString())
        if (!message) return

        if (message.type === 'MUTATION') {
          await refreshConnectionActivity(boardId, userId, sessionId, connectionId)

          if (isRateLimited(mutationRateLimitState, RATE_LIMIT_MAX_PER_SECOND)) {
            ws.send(serialize({ type: 'RATE_LIMITED' }))
            return
          }

          if (message.mutation.operation.type === 'MOVE_ELEMENTS' && message.mutation.operation.transient) {
            await mutationPubSub.publishMessage(boardId, {
              type: 'MUTATION',
              mutation: message.mutation,
              fromUserId: userId,
            }, connectionId)
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

          enqueueMutation(boardId, userId, connectionId, ws, message.mutation)
          return
        }

        if (message.type === 'PRESENCE') {
          await refreshConnectionActivity(boardId, userId, sessionId, connectionId)

          if (isRateLimited(presenceRateLimitState, PRESENCE_RATE_LIMIT_MAX_PER_SECOND)) {
            return
          }

          roomManager.broadcastToRoom(boardId, {
            type: 'PRESENCE',
            sessionId,
            userId,
            cursor: message.cursor,
            selectedIds: message.selectedIds ?? [],
            draggedIds: message.draggedIds ?? [],
            focusedElementId: message.focusedElementId ?? null,
            typingField: message.typingField ?? null,
            userName,
            avatarUrl,
            color,
          }, connectionId)
          return
        }

        if (message.type === 'PONG') {
          await boardStateService.touchViewerSession(boardId, sessionId)
          await boardStateService.trackClient(boardId, userId, connectionId)
          heartbeat.handlePong(boardId, connectionId)
          return
        }
      } catch (error) {
        console.error(`[WS] message handling failed for board=${boardId} conn=${connectionId}`, error)
      }
    })

    ws.on('close', async () => {
      try {
        const batchState = pendingMutationBatches.get(connectionId)
        if (batchState?.flushTimer) {
          clearTimeout(batchState.flushTimer)
        }
        await flushMutationBatch(boardId, userId, connectionId, ws, { sendAcks: false })
        pendingMutationBatches.delete(connectionId)

        const leaveResult = roomManager.leaveRoom(boardId, connectionId)
        if (!leaveResult.client) {
          return
        }

        await boardStateService.removeClient(boardId, userId, connectionId)
        if (!leaveResult.sessionStillActive) {
          await boardStateService.removeViewerSession(boardId, sessionId)
        }

        const globalClientCount = await boardStateService.getClientCount(boardId)
        if (globalClientCount <= 1) {
          await boardStateService.persistBoard(boardId)
        }
        if (globalClientCount === 0) {
          scheduleRoomFlush(boardId)
        }
      } catch (error) {
        console.error(`[WS] close handling failed for board=${boardId} conn=${connectionId}`, error)
      }
    })
  }

  return { onConnection }
}

export type WebSocketHandler = ReturnType<typeof createWebSocketHandler>
