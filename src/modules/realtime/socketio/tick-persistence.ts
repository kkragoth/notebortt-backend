import {
    SYSTEM_ACTOR_IDS,
    TICK_PERSIST_DEBOUNCE_MS,
    TICK_PERSIST_MAX_WAIT_MS,
} from '../socketio/constants.js';
import type { Mutation } from '@/modules/collaboration/index.js';
import type { SocketIoRealtimeDependencies } from '../socketio/types.js';
import { APP_EVENTS } from '@/shared/events.js';
import { logger } from '@/shared/logger.js';
import { MutationType } from '@/modules/collaboration/index.js';

interface TickPersistenceOptions {
  onPersistedChange?: (boardId: string, userId: string, change: unknown, senderId: string) => Promise<void>
}

export function createTickPersistenceManager(
    deps: SocketIoRealtimeDependencies,
    options: TickPersistenceOptions = {},
) {
    const pendingTickMovesByBoard = new Map<string, Map<string, { x: number; y: number }>>();
    const tickPersistDebounceTimers = new Map<string, NodeJS.Timeout>();
    const tickPersistMaxWaitTimers = new Map<string, NodeJS.Timeout>();
    const tickPersistUserByBoard = new Map<string, string>();

    function clearTimers(boardId: string): void {
        const debounceTimer = tickPersistDebounceTimers.get(boardId);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            tickPersistDebounceTimers.delete(boardId);
        }

        const maxWaitTimer = tickPersistMaxWaitTimers.get(boardId);
        if (maxWaitTimer) {
            clearTimeout(maxWaitTimer);
            tickPersistMaxWaitTimers.delete(boardId);
        }
    }

    async function flushTickMoves(boardId: string): Promise<void> {
        const pendingMoves = pendingTickMovesByBoard.get(boardId);
        if (!pendingMoves || pendingMoves.size === 0) {
            return;
        }

        const userId = tickPersistUserByBoard.get(boardId) ?? SYSTEM_ACTOR_IDS.tick;
        const moves = Array.from(pendingMoves.entries()).map(([elementId, position]) => ({
            elementId,
            x: position.x,
            y: position.y,
        }));

        pendingMoves.clear();
        clearTimers(boardId);
        pendingTickMovesByBoard.delete(boardId);

        if (moves.length === 0) {
            return;
        }

        await deps.boardStateService.loadBoard(boardId);
        const mutation: Mutation = {
            mutationId: `tick:${Date.now()}:${Math.random().toString(36).slice(2)}`,
            boardId,
            clientTimestamp: Date.now(),
            operation: { type: MutationType.MOVE_ELEMENTS, moves },
        };
        const results = await deps.mutationProcessor.processBatch([mutation], userId);
        await deps.events.emit(APP_EVENTS.BOARD_MUTATED, { boardId });
        for (const result of results) {
            if (result.status === 'applied' && result.change) {
                await options.onPersistedChange?.(boardId, userId, result.change, `tick:${boardId}`);
            }
        }
        tickPersistUserByBoard.delete(boardId);
    }

    function scheduleTickPersist(boardId: string): void {
        const debounceTimer = tickPersistDebounceTimers.get(boardId);
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        // Timer callbacks run detached: a rejection here would crash the
        // realtime process as an unhandled rejection, so failures are logged.
        tickPersistDebounceTimers.set(boardId, setTimeout(() => {
            tickPersistDebounceTimers.delete(boardId);
            flushTickMoves(boardId).catch((err) => logger.error({ err, boardId }, '[TickPersistence] flush failed'));
        }, TICK_PERSIST_DEBOUNCE_MS));

        if (!tickPersistMaxWaitTimers.has(boardId)) {
            tickPersistMaxWaitTimers.set(boardId, setTimeout(() => {
                tickPersistMaxWaitTimers.delete(boardId);
                flushTickMoves(boardId).catch((err) => logger.error({ err, boardId }, '[TickPersistence] max-wait flush failed'));
            }, TICK_PERSIST_MAX_WAIT_MS));
        }
    }

    function queueMoves(boardId: string, userId: string, moves: Array<{ id: string; x: number; y: number }>): void {
        if (moves.length === 0) {
            return;
        }

        let pendingMoves = pendingTickMovesByBoard.get(boardId);
        if (!pendingMoves) {
            pendingMoves = new Map<string, { x: number; y: number }>();
            pendingTickMovesByBoard.set(boardId, pendingMoves);
        }

        for (const move of moves) {
            pendingMoves.set(move.id, { x: move.x, y: move.y });
        }

        tickPersistUserByBoard.set(boardId, userId);
        scheduleTickPersist(boardId);
    }

    function clearBoard(boardId: string): void {
        clearTimers(boardId);
        pendingTickMovesByBoard.delete(boardId);
        tickPersistUserByBoard.delete(boardId);
    }

    return {
        flushTickMoves,
        queueMoves,
        clearBoard,
    };
}
