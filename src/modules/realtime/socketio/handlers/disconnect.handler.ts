import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';
import { APP_EVENTS } from '@/shared/events.js';

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
            // client-side beforeunload call is needed. Awaited emit never
            // rejects; a failed flush enqueue is logged by the bus.
            await runtime.deps.events.emit(APP_EVENTS.BOARD_EDITORS_LEFT, { boardId: context.boardId });
        }

        cleanupConnectionState();
    };
}
