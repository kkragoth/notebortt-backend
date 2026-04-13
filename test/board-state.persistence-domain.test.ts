import { describe, expect, it, vi } from 'vitest'
import { createBoardStateService } from '../src/services/board-state.service.js'

describe('board persistence domain logging', () => {
  it('does not emit dirty backlog logs for empty scans', async () => {
    const redis = {
      zrangebyscore: vi.fn().mockResolvedValue([]),
      zcard: vi.fn().mockResolvedValue(0),
    } as any

    const metrics = {
      incrementCounter: vi.fn(),
      observeTiming: vi.fn(),
      logStructured: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue({ counters: {}, timings: {} }),
    }

    const service = createBoardStateService(redis, {} as any, { metrics: metrics as any })

    const persisted = await service.persistDirtyBoards()

    expect(persisted).toEqual([])
    expect(metrics.logStructured).not.toHaveBeenCalledWith(
      'board.dirty_backlog',
      expect.anything(),
    )
  })
})
