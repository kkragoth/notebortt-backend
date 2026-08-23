import { describe, expect, it, vi } from 'vitest';
import { createBoardPersistenceService } from '@/modules/collaboration/board-persistence.service.js';

describe('board persistence worker policy', () => {
    it('flushDirtyBoards uses 30s window and retry options', async () => {
        const boardStateService = {
            persistDirtyBoards: vi.fn().mockResolvedValue(['board-1']),
        } as any;

        const service = createBoardPersistenceService(boardStateService);
        const persisted = await service.flushDirtyBoards();

        expect(persisted).toEqual(['board-1']);
        expect(boardStateService.persistDirtyBoards).toHaveBeenCalledWith({
            minDirtyAgeMs: 30_000,
            retryAttempts: 3,
            retryDelayMs: 250,
        });
    });

    it('starts the worker with a 30s poll interval by default', () => {
        const boardStateService = {
            persistDirtyBoards: vi.fn().mockResolvedValue([]),
        } as any;
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any);
        const service = createBoardPersistenceService(boardStateService);

        try {
            service.startWorker();

            expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
        } finally {
            setIntervalSpy.mockRestore();
        }
    });
});
