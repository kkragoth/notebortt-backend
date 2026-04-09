import type { Server as HttpServer } from 'http'
import { Server } from 'socket.io'
import { createCrdtRoomStore } from './crdt-room.js'
import { createParticipantsStore } from './participants.js'
import { createTickPersistenceManager } from './tick-persistence.js'
import { WS_ELEMENTS_CHANGED_TYPE } from './constants.js'
import type {
  RoomParticipant,
  SocketBoardContext,
  SocketIdentity,
  SocketIoRealtimeServerOptions,
  SocketIoRealtimeDependencies,
} from './types.js'
import { createBoardJoinHandler } from './handlers/join.handler.js'
import { createMutationBatchHandler } from './handlers/mutation-batch.handler.js'
import { createCrdtUpdateHandler } from './handlers/crdt-update.handler.js'
import { createPresenceUpdateHandler } from './handlers/presence-update.handler.js'
import { createRealtimeTickHandler } from './handlers/realtime-tick.handler.js'
import { createDisconnectHandler } from './handlers/disconnect.handler.js'
import type { ContextSnapshot, SocketIoHandlerRuntime } from './handlers/runtime.js'
import {
  decrementOpenSocketIoConnections,
  incrementOpenSocketIoConnections,
} from './stats.js'

const DEFAULT_ACTIVITY_WRITE_THROTTLE_MS = 3_000
const DEFAULT_ACTIVITY_WRITE_JITTER_MS = 400

function parseAllowedOrigins(raw: string): string[] {
  return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0)
}

export function createSocketIoRealtimeServer(
  httpServer: HttpServer,
  deps: SocketIoRealtimeDependencies,
  options: SocketIoRealtimeServerOptions,
) {
  const io = new Server(httpServer, {
    transports: ['websocket'],
    cors: {
      origin: parseAllowedOrigins(options.corsOrigin),
      credentials: true,
    },
  })

  async function publishElementsChanged(boardId: string, userId: string, change: unknown, senderId: string): Promise<void> {
    await deps.pubRedis.publish(
      `board:${boardId}:mutations`,
      JSON.stringify({
        message: { type: WS_ELEMENTS_CHANGED_TYPE, change, fromUserId: userId },
        senderConnectionId: `socketio:${senderId}`,
      }),
    )
  }

  const participantsStore = createParticipantsStore()
  const tickPersistence = createTickPersistenceManager(deps, { onPersistedChange: publishElementsChanged })
  const crdtStore = createCrdtRoomStore(deps.boardStateService, deps.mutationProcessor, {
    debounceMs: options.crdtDebounceMs,
    maxWaitMs: options.crdtMaxWaitMs,
    onPersistedChange: async (boardId, userId, change) => {
      await deps.pubRedis.publish(
        `board:${boardId}:mutations`,
        JSON.stringify({
          message: { type: WS_ELEMENTS_CHANGED_TYPE, change, fromUserId: userId },
          senderConnectionId: `socketio:crdt:${boardId}`,
        }),
      )
    },
  })

  function emitUserLeft(boardId: string, participant: RoomParticipant): void {
    io.to(boardId).emit('USER_LEFT', {
      sessionId: participant.sessionId,
      userId: participant.userId,
    })
  }

  io.on('connection', (socket) => {
    incrementOpenSocketIoConnections()
    socket.once('disconnect', () => {
      decrementOpenSocketIoConnections()
    })

    let boardContext: SocketBoardContext | null = null
    let boardContextVersion = 0
    let identity: SocketIdentity | null = null
    let lastTickId = -1
    let latestJoinAttempt = 0
    const lastActivityWriteAtBySocketId = new Map<string, number>()
    const activityJitterBySocketId = new Map<string, number>()

    function setBoardContext(next: SocketBoardContext | null): void {
      boardContext = next
      boardContextVersion += 1
      lastTickId = -1
    }

    function getBoardContext(): SocketBoardContext | null {
      return boardContext
    }

    function takeContextSnapshot(expectedBoardId?: string): ContextSnapshot | null {
      if (!boardContext) {
        return null
      }
      if (expectedBoardId && boardContext.boardId !== expectedBoardId) {
        return null
      }
      return { context: boardContext, version: boardContextVersion }
    }

    function isSnapshotActive(snapshot: ContextSnapshot): boolean {
      if (!socket.connected || !boardContext) {
        return false
      }
      if (snapshot.version !== boardContextVersion) {
        return false
      }
      return (
        snapshot.context.boardId === boardContext.boardId
        && snapshot.context.sessionId === boardContext.sessionId
      )
    }

    function startJoinAttempt(): number {
      latestJoinAttempt += 1
      return latestJoinAttempt
    }

    function isJoinActive(joinAttempt: number): boolean {
      return socket.connected && joinAttempt === latestJoinAttempt
    }

    function getIdentity(): SocketIdentity | null {
      return identity
    }

    function setIdentity(nextIdentity: SocketIdentity): void {
      identity = nextIdentity
    }

    function getLastTickId(): number {
      return lastTickId
    }

    function setLastTickId(tickId: number): void {
      lastTickId = tickId
    }

    function shouldWriteActivity(): boolean {
      const now = Date.now()
      const lastWriteAt = lastActivityWriteAtBySocketId.get(socket.id) ?? 0
      const jitter = activityJitterBySocketId.get(socket.id)
        ?? Math.floor(Math.random() * (DEFAULT_ACTIVITY_WRITE_JITTER_MS + 1))
      activityJitterBySocketId.set(socket.id, jitter)
      const effectiveWindow = Math.max(0, DEFAULT_ACTIVITY_WRITE_THROTTLE_MS + jitter)

      if ((now - lastWriteAt) >= effectiveWindow) {
        lastActivityWriteAtBySocketId.set(socket.id, now)
        return true
      }

      return false
    }

    async function refreshSocketActivity(snapshot: ContextSnapshot, forceWrite = false): Promise<void> {
      if (!forceWrite && !shouldWriteActivity()) {
        return
      }

      await deps.boardStateService.touchViewerSession(snapshot.context.boardId, snapshot.context.sessionId)
      await deps.boardStateService.trackClient(snapshot.context.boardId, snapshot.context.userId, socket.id)
    }

    async function cleanupBoardRealtimeStateIfEmpty(boardId: string): Promise<void> {
      if (participantsStore.getRoomSize(boardId) > 0) {
        return
      }

      await tickPersistence.flushTickMoves(boardId)
      await crdtStore.flushNow(boardId)
      tickPersistence.clearBoard(boardId)
      crdtStore.clearRoom(boardId)
    }

    async function detachFromBoard(context: SocketBoardContext, broadcastLeave: boolean): Promise<void> {
      await deps.boardStateService.removeClient(context.boardId, context.userId, socket.id)
      await deps.boardStateService.removeViewerSession(context.boardId, context.sessionId)

      const participant = participantsStore.removeParticipant(context.boardId, socket.id)
      if (broadcastLeave && participant) {
        emitUserLeft(context.boardId, participant)
      }
      socket.leave(context.boardId)
      await cleanupBoardRealtimeStateIfEmpty(context.boardId)
    }

    function cleanupConnectionState(): void {
      lastActivityWriteAtBySocketId.delete(socket.id)
      activityJitterBySocketId.delete(socket.id)
    }

    const runtime: SocketIoHandlerRuntime = {
      socket,
      deps,
      participantsStore,
      tickPersistence,
      crdtStore,
      setBoardContext,
      getBoardContext,
      takeContextSnapshot,
      isSnapshotActive,
      startJoinAttempt,
      isJoinActive,
      getIdentity,
      setIdentity,
      getLastTickId,
      setLastTickId,
      refreshSocketActivity,
      detachFromBoard,
      publishElementsChanged,
    }

    function registerHandler(event: string, handler: (payload: unknown) => Promise<void>): void {
      socket.on(event, (payload: unknown) => {
        void (async () => {
          try {
            await handler(payload)
          } catch (error) {
            console.error('[socketio] unhandled handler error', {
              event,
              socketId: socket.id,
              error,
            })
            if (socket.connected) {
              socket.emit('sync:error', { message: 'Internal realtime server error' })
            }
          }
        })()
      })
    }

    registerHandler('board:join', createBoardJoinHandler(runtime))
    registerHandler('mutation:batch', createMutationBatchHandler(runtime))
    registerHandler('crdt:update', createCrdtUpdateHandler(runtime))
    registerHandler('presence:update', createPresenceUpdateHandler(runtime))
    registerHandler('realtime:tick', createRealtimeTickHandler(runtime))
    registerHandler('disconnect', createDisconnectHandler(runtime, cleanupConnectionState))
  })

  return io
}
