import type { BoardStateService } from './/board-state.service.js';

const DEFAULT_PERSIST_WINDOW_MS = 30_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Flush policy only — scheduling lives in src/app/background-jobs.ts as a
 * BullMQ repeatable job so it is single-flight across replicas.
 */
export function createBoardPersistenceService(boardStateService: BoardStateService) {
    async function flushDirtyBoards(): Promise<string[]> {
        return boardStateService.persistDirtyBoards({
            minDirtyAgeMs: DEFAULT_PERSIST_WINDOW_MS,
            retryAttempts: DEFAULT_RETRY_ATTEMPTS,
            retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        });
    }

    return {
        flushDirtyBoards,
    };
}

export type BoardPersistenceService = ReturnType<typeof createBoardPersistenceService>
