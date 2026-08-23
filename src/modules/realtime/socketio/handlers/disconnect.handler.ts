import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';

export function createDisconnectHandler(
    runtime: SocketIoHandlerRuntime,
    cleanupConnectionState: () => void,
) {
    return async (): Promise<void> => {
        const context = runtime.getBoardContext();
        if (!context) {
            cleanupConnectionState();
            return;
        }

        runtime.setBoardContext(null);
        await runtime.detachFromBoard(context, true);

        if (context.permission === 'edit') {
            // Tab close / navigation also lands here (socket dies), so no
            // client-side beforeunload call is needed.
            void runtime.deps.previewJobService.enqueueFlush(context.boardId).catch(() => undefined);
        }

        cleanupConnectionState();
    };
}
