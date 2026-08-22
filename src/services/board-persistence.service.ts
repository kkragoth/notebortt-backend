import type { BoardStateService } from '@/services/board-state.service.js';

const DEFAULT_PERSIST_INTERVAL_MS = 30_000;
const DEFAULT_PERSIST_WINDOW_MS = 30_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

export function createBoardPersistenceService(boardStateService: BoardStateService) {
    async function flushDirtyBoards(): Promise<string[]> {
        return boardStateService.persistDirtyBoards({
            minDirtyAgeMs: DEFAULT_PERSIST_WINDOW_MS,
            retryAttempts: DEFAULT_RETRY_ATTEMPTS,
            retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        });
    }

    function startWorker(intervalMs = DEFAULT_PERSIST_INTERVAL_MS): NodeJS.Timeout {
        return setInterval(async () => {
            try {
                await flushDirtyBoards();
            } catch (error) {
                console.error('[BoardPersistence] flush failed', error);
            }
        }, intervalMs);
    }

    return {
        flushDirtyBoards,
        startWorker,
    };
}

export type BoardPersistenceService = ReturnType<typeof createBoardPersistenceService>
