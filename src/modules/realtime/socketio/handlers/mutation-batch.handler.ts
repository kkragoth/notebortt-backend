import { parseMutationBatchPayload } from '../../socketio/payloads.js';
import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';

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
            runtime.socket.emit('sync:error', { message: 'Invalid mutation batch payload' });
            return;
        }
        if (!hasConsistentBatchBoardId(payload.boardId, payload.mutations)) {
            runtime.socket.emit('sync:error', { message: 'Mutation board mismatch' });
            return;
        }
        if (snapshot.context.permission !== 'edit') {
            runtime.socket.emit('sync:error', { message: 'No edit access to this board' });
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
                runtime.socket.to(payload.boardId).emit('mutation', { mutation });
            }

            if (result.status === 'applied' && result.change) {
                await runtime.publishElementsChanged(payload.boardId, snapshot.context.userId, result.change, runtime.socket.id);
            }
        }

        if (runtime.socket.connected && runtime.isSnapshotActive(snapshot)) {
            runtime.socket.emit('mutation:ack', { mutationIds: acknowledgedIds, sequence: latestSequence });
        }
    };
}
