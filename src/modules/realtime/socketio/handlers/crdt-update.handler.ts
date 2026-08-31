import { parseCrdtUpdatePayload } from '../../socketio/payloads.js';
import { SOCKET_SERVER_EVENTS } from '../../socketio/constants.js';
import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';

export function createCrdtUpdateHandler(runtime: SocketIoHandlerRuntime) {
    return async (rawPayload: unknown): Promise<void> => {
        const payload = parseCrdtUpdatePayload(rawPayload);
        const snapshot = payload ? runtime.takeContextSnapshot(payload.boardId) : null;
        if (!payload || !snapshot) {
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Invalid CRDT update payload' });
            return;
        }
        if (snapshot.context.permission !== 'edit') {
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'No edit access to this board' });
            return;
        }

        await runtime.refreshSocketActivity(snapshot);
        if (!runtime.isSnapshotActive(snapshot)) {
            return;
        }

        runtime.crdtStore.applyRemoteUpdate(payload.boardId, snapshot.context.userId, payload.update);
        runtime.safeEmitToBoard(payload.boardId, SOCKET_SERVER_EVENTS.CRDT_UPDATE, { boardId: payload.boardId, update: payload.update });
    };
}
