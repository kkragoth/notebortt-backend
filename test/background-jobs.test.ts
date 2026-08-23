import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import { createBackgroundJobs } from '@/app/background-jobs.js';

vi.mock('bullmq', async () => {
    const actual = await vi.importActual<typeof import('bullmq')>('bullmq');
    return {
        ...actual,
        Queue: vi.fn(),
        Worker: vi.fn(),
    };
});

const queueInstances: any[] = [];

function createMockQueue() {
    const instance = {
        name: `queue-${queueInstances.length}`,
        upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
    };
    queueInstances.push(instance);
    return instance;
}

const workerInstances: any[] = [];

vi.mock('@/platform/jobs/queues.js', async () => {
    const actual = await vi.importActual<typeof import('@/platform/jobs/queues.js')>('@/platform/jobs/queues.js');
    return {
        ...actual,
        createRepeatableWorker: vi.fn((...args) => {
            workerInstances.push(args);
            return { name: `worker-${workerInstances.length}`, close: vi.fn().mockResolvedValue(undefined) };
        }),
    };
});

describe('background jobs composition', () => {
    let runtime: any;

    beforeEach(() => {
        vi.clearAllMocks();
        queueInstances.length = 0;
        workerInstances.length = 0;
        vi.mocked(Queue).mockImplementation(createMockQueue);
        runtime = {
            config: { boardPersistIntervalMs: 30_000, redisCleanupIntervalMs: 120_000 },
            jobsRedis: {},
            boardPersistenceService: { flushDirtyBoards: vi.fn().mockResolvedValue([]) },
            redisCleanupService: {
                cleanupInactiveBoards: vi.fn().mockResolvedValue([]),
                cleanupTransientDataByIdleTime: vi.fn().mockResolvedValue([]),
            },
        };
    });

    it('registers exactly one repeatable schedule per queue with configured intervals', async () => {
        const jobs = createBackgroundJobs(runtime);
        await jobs.start();

        expect(queueInstances[0].upsertJobScheduler).toHaveBeenCalledWith(
            'flush-dirty-boards',
            { every: 30_000 },
            expect.objectContaining({ name: 'flush-dirty-boards' }),
        );
        expect(queueInstances[1].upsertJobScheduler).toHaveBeenCalledWith(
            'cleanup-inactive-boards',
            { every: 120_000 },
            expect.objectContaining({ name: 'cleanup-inactive-boards' }),
        );
        expect(vi.mocked(Queue)).toHaveBeenCalledTimes(2);

        await jobs.stop();
    });

    it('stop closes workers and queues so shutdown is uniform', async () => {
        const jobs = createBackgroundJobs(runtime);
        await jobs.start();
        await jobs.stop();

        for (const instance of queueInstances) {
            expect(instance.close).toHaveBeenCalledTimes(1);
        }
        expect(jobs.getQueues()).toEqual([]);
    });
});
