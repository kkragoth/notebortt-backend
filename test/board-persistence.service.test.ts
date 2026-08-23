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

    it('exposes no in-process scheduling surface (BullMQ owns timing)', () => {
        const boardStateService = {
            persistDirtyBoards: vi.fn().mockResolvedValue([]),
        } as any;

        const service = createBoardPersistenceService(boardStateService);

        expect(Object.keys(service)).toEqual(['flushDirtyBoards']);
    });
});
