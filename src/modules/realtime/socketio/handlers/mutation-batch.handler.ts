import { parseMutationBatchPayload } from '../../socketio/payloads.js';
import { SOCKET_SERVER_EVENTS } from '../../socketio/constants.js';
import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';
import { APP_EVENTS } from '@/shared/events.js';

function hasConsistentBatchBoardId(boardId: string, mutations: unknown[]): boolean {
    return mutations.every((mutation) => {
        if (!mutation || typeof mutation !== 'object') {
            return false;
        }
        const mutationBoardId = (mutation as { boardId?: unknown }).boardId;
        return mutationBoardId === boardId;
    });
}

export function createMutationBatchHandler(runtime: SocketIoHandlerRuntime) {
    return async (rawPayload: unknown): Promise<void> => {
        const payload = parseMutationBatchPayload(rawPayload);
        const snapshot = payload ? runtime.takeContextSnapshot(payload.boardId) : null;
        if (!payload || !snapshot) {
            runtime.socket.emit(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Invalid mutation batch payload' });
            return;
        }
        if (!hasConsistentBatchBoardId(payload.boardId, payload.mutations)) {
            runtime.socket.emit(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Mutation board mismatch' });
            return;
        }
        if (snapshot.context.permission !== 'edit') {
            runtime.socket.emit(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'No edit access to this board' });
            return;
        }

        await runtime.refreshSocketActivity(snapshot);
        if (!runtime.isSnapshotActive(snapshot)) {
            return;
        }

        const results = await runtime.deps.mutationProcessor.processBatch(payload.mutations, snapshot.context.userId);
        if (!runtime.isSnapshotActive(snapshot)) {
            return;
        }
        runtime.deps.events.emit(APP_EVENTS.BOARD_MUTATED, { boardId: snapshot.context.boardId });

        const acknowledgedIds: string[] = [];
        let latestSequence: number | undefined;

        for (let index = 0; index < results.length; index += 1) {
            const result = results[index];
            const mutation = payload.mutations[index];
            if (!result || !mutation) {
                continue;
            }

            acknowledgedIds.push(result.mutationId);
            if (typeof result.sequence === 'number') {
                latestSequence = result.sequence;
            }

            if (result.status !== 'already_applied') {
                runtime.socket.to(payload.boardId).emit(SOCKET_SERVER_EVENTS.MUTATION_BROADCAST, { mutation });
            }

        }

        if (runtime.socket.connected && runtime.isSnapshotActive(snapshot)) {
            runtime.socket.emit(SOCKET_SERVER_EVENTS.MUTATION_ACK, { mutationIds: acknowledgedIds, sequence: latestSequence });
        }
    };
}
