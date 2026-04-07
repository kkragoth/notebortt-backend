import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type WebSocket from 'ws'
import type Redis from 'ioredis'
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
    sendExistingRoomMembers(ws, boardId, connectionId)
    roomManager.joinRoom(boardId, client)

    await sendInitialState(ws, boardId, lastSequence, boardStateService, pubRedis)

    const mutationRateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }
    const presenceRateLimitState: RateLimitState = { count: 0, windowStart: Date.now() }

    ws.on('message', async (raw: Buffer) => {
      try {
        const message = parseClientMessage(raw.toString())
        if (!message) return

        if (message.type === 'MUTATION') {
          await boardStateService.touchViewerSession(boardId, sessionId)

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

          const result = await mutationProcessor.processMutation(message.mutation, userId)
          ws.send(serialize({ type: 'MUTATION_RESULT', result }))

          if (result.status === 'applied' && result.change) {
            const serverMessage = {
              type: 'ELEMENTS_CHANGED' as const,
              change: result.change,
              fromUserId: userId,
            }

            roomManager.broadcastToRoom(boardId, serverMessage, connectionId)
            await mutationPubSub.publishMessage(boardId, serverMessage, connectionId)
          }
          return
        }

        if (message.type === 'PRESENCE') {
          await boardStateService.touchViewerSession(boardId, sessionId)

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
          heartbeat.handlePong(boardId, connectionId)
          return
        }
      } catch (error) {
        console.error(`[WS] message handling failed for board=${boardId} conn=${connectionId}`, error)
      }
    })

    ws.on('close', async () => {
      try {
        roomManager.leaveRoom(boardId, connectionId)
        await boardStateService.removeClient(boardId, userId, connectionId)
        await boardStateService.removeViewerSession(boardId, sessionId)

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
