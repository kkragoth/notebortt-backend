import type { Server as HttpServer } from 'http'
import { Server } from 'socket.io'
import { createCrdtRoomStore } from './crdt-room.js'
import { resolveSocketIdentity } from './identity.js'
import { createParticipantsStore } from './participants.js'
import { createTickPersistenceManager } from './tick-persistence.js'
import { WS_ELEMENTS_CHANGED_TYPE } from './constants.js'
import type {
  RoomParticipant,
  SocketBoardContext,
  SocketIdentity,
  SocketIoRealtimeDependencies,
  SocketIoRealtimeServerOptions,
} from './types.js'
import { getUserColor } from '../ws/room.js'
import {
  parseBoardJoinPayload,
  parseCrdtUpdatePayload,
  parseMutationBatchPayload,
  parsePresenceUpdatePayload,
  parseRealtimeTickPayload,
} from './payloads.js'

type PresenceTypingField = 'title' | 'body' | null

type ContextSnapshot = {
  context: SocketBoardContext
  version: number
}

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
    let boardContext: SocketBoardContext | null = null
    let boardContextVersion = 0
    let identity: SocketIdentity | null = null
    let lastTickId = -1
    let latestJoinAttempt = 0

    function setBoardContext(next: SocketBoardContext | null): void {
      boardContext = next
      boardContextVersion += 1
      if (!next) {
        lastTickId = -1
      }
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

    registerHandler('board:join', async (rawPayload) => {
      const payload = parseBoardJoinPayload(rawPayload)
      if (!payload) {
        socket.emit('sync:error', { message: 'Invalid board join payload' })
        return
      }

      const joinAttempt = ++latestJoinAttempt
      const isJoinActive = () => socket.connected && joinAttempt === latestJoinAttempt

      identity = identity ?? await resolveSocketIdentity(socket, deps)
      if (!isJoinActive() || !identity) {
        return
      }

      const shareToken = payload.shareToken ?? (typeof socket.handshake.query.shareToken === 'string'
        ? socket.handshake.query.shareToken
        : undefined)
      const access = await deps.boardService.checkBoardAccess(payload.boardId, identity.authUserId, shareToken)
      if (!isJoinActive()) {
        return
      }
      if (!access.hasAccess) {
        socket.emit('sync:error', { message: 'No access to board' })
        return
      }

      const previousContext = boardContext
      if (previousContext && previousContext.boardId !== payload.boardId) {
        const previousParticipant = participantsStore.removeParticipant(previousContext.boardId, socket.id)
        if (previousParticipant) {
          emitUserLeft(previousContext.boardId, previousParticipant)
        }
        socket.leave(previousContext.boardId)
      }

      await deps.boardStateService.loadBoard(payload.boardId)
      if (!isJoinActive()) {
        return
      }
      await deps.boardStateService.trackClient(payload.boardId, identity.runtimeUserId, socket.id)
      if (!isJoinActive()) {
        return
      }
      await deps.boardStateService.touchViewerSession(payload.boardId, payload.sessionId)
      if (!isJoinActive()) {
        return
      }

      socket.join(payload.boardId)

      const color = getUserColor(identity.runtimeUserId)
      const nextContext: SocketBoardContext = {
        boardId: payload.boardId,
        permission: access.permission === 'edit' ? 'edit' : 'view',
        sessionId: payload.sessionId,
        userId: identity.runtimeUserId,
        userName: identity.userName,
        avatarUrl: identity.avatarUrl,
        color,
      }
      setBoardContext(nextContext)

      const participants = participantsStore.getRoomParticipantMap(payload.boardId)
      for (const existingParticipant of participants.values()) {
        if (existingParticipant.sessionId === payload.sessionId) {
          continue
        }
        socket.emit('USER_JOINED', existingParticipant)
      }

      participants.set(socket.id, {
        sessionId: payload.sessionId,
        userId: identity.runtimeUserId,
        userName: identity.userName,
        avatarUrl: identity.avatarUrl,
        color,
      })

      socket.to(payload.boardId).emit('USER_JOINED', {
        sessionId: payload.sessionId,
        userId: identity.runtimeUserId,
        userName: identity.userName,
        avatarUrl: identity.avatarUrl,
        color,
      })

      const snapshot = await deps.boardStateService.getSnapshot(payload.boardId)
      if (!isJoinActive() || !boardContext || boardContext.sessionId !== payload.sessionId) {
        return
      }

      socket.emit('board:snapshot', {
        elements: snapshot.elements,
        lastSequence: snapshot.sequence,
      })
    })

    registerHandler('mutation:batch', async (rawPayload) => {
      const payload = parseMutationBatchPayload(rawPayload)
      const snapshot = payload ? takeContextSnapshot(payload.boardId) : null
      if (!payload || !snapshot) {
        socket.emit('sync:error', { message: 'Invalid mutation batch payload' })
        return
      }
      if (snapshot.context.permission !== 'edit') {
        socket.emit('sync:error', { message: 'No edit access to this board' })
        return
      }

      await deps.boardStateService.touchViewerSession(snapshot.context.boardId, snapshot.context.sessionId)
      await deps.boardStateService.trackClient(snapshot.context.boardId, snapshot.context.userId, socket.id)
      if (!isSnapshotActive(snapshot)) {
        return
      }

      const results = await deps.mutationProcessor.processBatch(payload.mutations, snapshot.context.userId)
      if (!isSnapshotActive(snapshot)) {
        return
      }

      const acknowledgedIds: string[] = []
      let latestSequence: number | undefined

      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        const mutation = payload.mutations[index]
        if (!result || !mutation) {
          continue
        }

        acknowledgedIds.push(result.mutationId)
        if (typeof result.sequence === 'number') {
          latestSequence = result.sequence
        }

        if (result.status !== 'already_applied') {
          socket.to(payload.boardId).emit('mutation', { mutation })
        }

        if (result.status === 'applied' && result.change) {
          await publishElementsChanged(payload.boardId, snapshot.context.userId, result.change, socket.id)
        }
      }

      if (socket.connected && isSnapshotActive(snapshot)) {
        socket.emit('mutation:ack', { mutationIds: acknowledgedIds, sequence: latestSequence })
      }
    })

    registerHandler('crdt:update', async (rawPayload) => {
      const payload = parseCrdtUpdatePayload(rawPayload)
      const snapshot = payload ? takeContextSnapshot(payload.boardId) : null
      if (!payload || !snapshot) {
        socket.emit('sync:error', { message: 'Invalid CRDT update payload' })
        return
      }
      if (snapshot.context.permission !== 'edit') {
        socket.emit('sync:error', { message: 'No edit access to this board' })
        return
      }

      await deps.boardStateService.touchViewerSession(snapshot.context.boardId, snapshot.context.sessionId)
      await deps.boardStateService.trackClient(snapshot.context.boardId, snapshot.context.userId, socket.id)
      if (!isSnapshotActive(snapshot)) {
        return
      }

      crdtStore.applyRemoteUpdate(payload.boardId, snapshot.context.userId, payload.update)
      socket.to(payload.boardId).emit('crdt:update', { boardId: payload.boardId, update: payload.update })
    })

    registerHandler('presence:update', async (rawPayload) => {
      const payload = parsePresenceUpdatePayload(rawPayload)
      const snapshot = payload ? takeContextSnapshot(payload.boardId) : null
      if (!payload || !snapshot) {
        socket.emit('sync:error', { message: 'Invalid presence payload' })
        return
      }

      await deps.boardStateService.touchViewerSession(snapshot.context.boardId, snapshot.context.sessionId)
      await deps.boardStateService.trackClient(snapshot.context.boardId, snapshot.context.userId, socket.id)
      if (!isSnapshotActive(snapshot)) {
        return
      }

      const typingField: PresenceTypingField = payload.typingField
      socket.to(payload.boardId).emit('PRESENCE', {
        sessionId: snapshot.context.sessionId,
        userId: snapshot.context.userId,
        userName: snapshot.context.userName,
        avatarUrl: snapshot.context.avatarUrl,
        color: snapshot.context.color,
        cursor: payload.cursor,
        selectedIds: payload.selectedIds,
        draggedIds: payload.draggedIds,
        focusedElementId: payload.focusedElementId,
        typingField,
      })
    })

    registerHandler('realtime:tick', async (rawPayload) => {
      const payload = parseRealtimeTickPayload(rawPayload)
      const snapshot = payload ? takeContextSnapshot(payload.boardId) : null
      if (!payload || !snapshot) {
        socket.emit('sync:error', { message: 'Invalid realtime tick payload' })
        return
      }

      if (payload.tickId <= lastTickId) {
        return
      }
      lastTickId = payload.tickId

      if (payload.moves.length > 0 && snapshot.context.permission !== 'edit') {
        socket.emit('sync:error', { message: 'No edit access to this board' })
        return
      }

      await deps.boardStateService.touchViewerSession(snapshot.context.boardId, snapshot.context.sessionId)
      await deps.boardStateService.trackClient(snapshot.context.boardId, snapshot.context.userId, socket.id)
      if (!isSnapshotActive(snapshot)) {
        return
      }

      if (payload.moves.length > 0) {
        tickPersistence.queueMoves(payload.boardId, snapshot.context.userId, payload.moves)
      }

      const typingField: PresenceTypingField = payload.typingField
      socket.to(payload.boardId).emit('realtime:tick', {
        boardId: payload.boardId,
        tickId: payload.tickId,
        sessionId: snapshot.context.sessionId,
        userId: snapshot.context.userId,
        userName: snapshot.context.userName,
        avatarUrl: snapshot.context.avatarUrl,
        color: snapshot.context.color,
        cursor: payload.cursor,
        selectedIds: payload.selectedIds,
        draggedIds: payload.draggedIds,
        focusedElementId: payload.focusedElementId,
        typingField,
        presenceState: payload.presenceState,
        presenceMessage: payload.presenceMessage,
        moves: payload.moves,
      })
    })

    registerHandler('disconnect', async () => {
      const snapshot = takeContextSnapshot()
      if (!snapshot) {
        return
      }

      setBoardContext(null)

      await tickPersistence.flushTickMoves(snapshot.context.boardId)
      await crdtStore.flushNow(snapshot.context.boardId)
      await deps.boardStateService.removeClient(snapshot.context.boardId, snapshot.context.userId, socket.id)
      await deps.boardStateService.removeViewerSession(snapshot.context.boardId, snapshot.context.sessionId)

      const participant = participantsStore.removeParticipant(snapshot.context.boardId, socket.id)
      if (participant) {
        emitUserLeft(snapshot.context.boardId, participant)
      }
    })
  })

  return io
}
