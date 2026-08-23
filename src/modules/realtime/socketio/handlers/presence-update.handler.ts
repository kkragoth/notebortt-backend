import { parsePresenceUpdatePayload } from '../../socketio/payloads.js';
import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';

export function createPresenceUpdateHandler(runtime: SocketIoHandlerRuntime) {
    return async (rawPayload: unknown): Promise<void> => {
        const payload = parsePresenceUpdatePayload(rawPayload);
        const snapshot = payload ? runtime.takeContextSnapshot(payload.boardId) : null;
        if (!payload || !snapshot) {
            runtime.socket.emit('sync:error', { message: 'Invalid presence payload' });
            return;
        }

        await runtime.refreshSocketActivity(snapshot);
        if (!runtime.isSnapshotActive(snapshot)) {
            return;
        }

        runtime.socket.to(payload.boardId).emit('PRESENCE', {
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
        });
    };
}
