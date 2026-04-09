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
    let identity: SocketIdentity | null = null
    let lastTickId = -1

    socket.on('board:join', async (rawPayload: unknown) => {
      const payload = parseBoardJoinPayload(rawPayload)
      if (!payload) {
        socket.emit('sync:error', { message: 'Invalid board join payload' })
        return
      }

      identity = identity ?? await resolveSocketIdentity(socket, deps)
      const shareToken = payload.shareToken ?? (typeof socket.handshake.query.shareToken === 'string'
        ? socket.handshake.query.shareToken
        : undefined)
      const access = await deps.boardService.checkBoardAccess(payload.boardId, identity.authUserId, shareToken)
      if (!access.hasAccess) {
        socket.emit('sync:error', { message: 'No access to board' })
        return
      }

      if (boardContext && boardContext.boardId !== payload.boardId) {
        const previousParticipant = participantsStore.removeParticipant(boardContext.boardId, socket.id)
        if (previousParticipant) {
          emitUserLeft(boardContext.boardId, previousParticipant)
        }
        socket.leave(boardContext.boardId)
      }

      await deps.boardStateService.loadBoard(payload.boardId)
      await deps.boardStateService.trackClient(payload.boardId, identity.runtimeUserId, socket.id)
      await deps.boardStateService.touchViewerSession(payload.boardId, payload.sessionId)
      socket.join(payload.boardId)

      const color = getUserColor(identity.runtimeUserId)
      boardContext = {
        boardId: payload.boardId,
        permission: access.permission === 'edit' ? 'edit' : 'view',
        sessionId: payload.sessionId,
        userId: identity.runtimeUserId,
        userName: identity.userName,
        avatarUrl: identity.avatarUrl,
        color,
      }

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
      socket.emit('board:snapshot', {
        elements: snapshot.elements,
        lastSequence: snapshot.sequence,
      })
    })

    socket.on('mutation:batch', async (rawPayload: unknown) => {
      const payload = parseMutationBatchPayload(rawPayload)
      if (!payload || !boardContext || payload.boardId !== boardContext.boardId) {
        socket.emit('sync:error', { message: 'Invalid mutation batch payload' })
        return
      }
      if (boardContext.permission !== 'edit') {
        socket.emit('sync:error', { message: 'No edit access to this board' })
        return
      }

      await deps.boardStateService.touchViewerSession(boardContext.boardId, boardContext.sessionId)
      await deps.boardStateService.trackClient(boardContext.boardId, boardContext.userId, socket.id)

      const results = await deps.mutationProcessor.processBatch(payload.mutations, boardContext.userId)
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
          await publishElementsChanged(payload.boardId, boardContext.userId, result.change, socket.id)
        }
      }

      socket.emit('mutation:ack', { mutationIds: acknowledgedIds, sequence: latestSequence })
    })

    socket.on('crdt:update', async (rawPayload: unknown) => {
      const payload = parseCrdtUpdatePayload(rawPayload)
      if (!payload || !boardContext || payload.boardId !== boardContext.boardId) {
        socket.emit('sync:error', { message: 'Invalid CRDT update payload' })
        return
      }
      if (boardContext.permission !== 'edit') {
        socket.emit('sync:error', { message: 'No edit access to this board' })
        return
      }

      await deps.boardStateService.touchViewerSession(boardContext.boardId, boardContext.sessionId)
      await deps.boardStateService.trackClient(boardContext.boardId, boardContext.userId, socket.id)
      crdtStore.applyRemoteUpdate(payload.boardId, boardContext.userId, payload.update)
      socket.to(payload.boardId).emit('crdt:update', { boardId: payload.boardId, update: payload.update })
    })

    socket.on('presence:update', async (rawPayload: unknown) => {
      const payload = parsePresenceUpdatePayload(rawPayload)
      const currentContext = boardContext
      if (!payload || !currentContext || payload.boardId !== currentContext.boardId) {
        socket.emit('sync:error', { message: 'Invalid presence payload' })
        return
      }

      await deps.boardStateService.touchViewerSession(currentContext.boardId, currentContext.sessionId)
      await deps.boardStateService.trackClient(currentContext.boardId, currentContext.userId, socket.id)

      if (boardContext !== currentContext) {
        return
      }

      const typingField: PresenceTypingField = payload.typingField
      socket.to(payload.boardId).emit('PRESENCE', {
        sessionId: currentContext.sessionId,
        userId: currentContext.userId,
        userName: currentContext.userName,
        avatarUrl: currentContext.avatarUrl,
        color: currentContext.color,
        cursor: payload.cursor,
        selectedIds: payload.selectedIds,
        draggedIds: payload.draggedIds,
        focusedElementId: payload.focusedElementId,
        typingField,
      })
    })

    socket.on('realtime:tick', async (rawPayload: unknown) => {
      const payload = parseRealtimeTickPayload(rawPayload)
      const currentContext = boardContext
      if (!payload || !currentContext || payload.boardId !== currentContext.boardId) {
        socket.emit('sync:error', { message: 'Invalid realtime tick payload' })
        return
      }

      if (payload.tickId <= lastTickId) {
        return
      }
      lastTickId = payload.tickId

      if (payload.moves.length > 0 && currentContext.permission !== 'edit') {
        socket.emit('sync:error', { message: 'No edit access to this board' })
        return
      }

      await deps.boardStateService.touchViewerSession(currentContext.boardId, currentContext.sessionId)
      await deps.boardStateService.trackClient(currentContext.boardId, currentContext.userId, socket.id)

      if (boardContext !== currentContext) {
        return
      }

      if (payload.moves.length > 0) {
        tickPersistence.queueMoves(payload.boardId, currentContext.userId, payload.moves)
      }

      const typingField: PresenceTypingField = payload.typingField
      socket.to(payload.boardId).emit('realtime:tick', {
        boardId: payload.boardId,
        tickId: payload.tickId,
        sessionId: currentContext.sessionId,
        userId: currentContext.userId,
        userName: currentContext.userName,
        avatarUrl: currentContext.avatarUrl,
        color: currentContext.color,
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

    socket.on('disconnect', async () => {
      if (!boardContext) {
        return
      }

      await tickPersistence.flushTickMoves(boardContext.boardId)
      await crdtStore.flushNow(boardContext.boardId)
      await deps.boardStateService.removeClient(boardContext.boardId, boardContext.userId, socket.id)
      await deps.boardStateService.removeViewerSession(boardContext.boardId, boardContext.sessionId)

      const participant = participantsStore.removeParticipant(boardContext.boardId, socket.id)
      if (participant) {
        emitUserLeft(boardContext.boardId, participant)
      }

      boardContext = null
    })
  })

  return io
}
