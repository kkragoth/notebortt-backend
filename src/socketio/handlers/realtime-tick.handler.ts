import { parseRealtimeTickPayload } from '../payloads.js'
import type { SocketIoHandlerRuntime } from './runtime.js'

export function createRealtimeTickHandler(runtime: SocketIoHandlerRuntime) {
  return async (rawPayload: unknown): Promise<void> => {
    const payload = parseRealtimeTickPayload(rawPayload)
    const snapshot = payload ? runtime.takeContextSnapshot(payload.boardId) : null
    if (!payload || !snapshot) {
      runtime.socket.emit('sync:error', { message: 'Invalid realtime tick payload' })
      return
    }

    if (payload.tickId <= runtime.getLastTickId()) {
      return
    }
    runtime.setLastTickId(payload.tickId)

    if (payload.moves.length > 0 && snapshot.context.permission !== 'edit') {
      runtime.socket.emit('sync:error', { message: 'No edit access to this board' })
      return
    }

    await runtime.refreshSocketActivity(snapshot)
    if (!runtime.isSnapshotActive(snapshot)) {
      return
    }

    if (payload.moves.length > 0) {
      runtime.tickPersistence.queueMoves(payload.boardId, snapshot.context.userId, payload.moves)
    }

    runtime.socket.to(payload.boardId).emit('realtime:tick', {
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
      typingField: payload.typingField,
      presenceState: payload.presenceState,
      presenceMessage: payload.presenceMessage,
      moves: payload.moves,
    })
  }
}
