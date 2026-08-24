import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { AppRuntime } from '@/app/runtime.js';
import type {JobQueueName, JobsWorkerHandle} from '@/platform/jobs/queues.js';
import {
    BOARD_CLEANUP_JOB,
    BOARD_PERSIST_FLUSH_JOB,
    JOB_QUEUES,
    
    
    createJobsQueue,
    createRepeatableWorker,
    upsertRepeatableJob
} from '@/platform/jobs/queues.js';

export interface BackgroundJobs {
    start: () => Promise<void>
    stop: () => Promise<void>
    getQueues: () => Queue[]
}

export function createBackgroundJobs(
    runtime: Pick<
        AppRuntime,
        'config' | 'jobsRedis' | 'boardPersistenceService' | 'redisCleanupService'
    >,
): BackgroundJobs {
    const connection: Redis = runtime.jobsRedis;
    const workers: JobsWorkerHandle[] = [];
    const queues: Queue[] = [];

    function registerQueue(name: JobQueueName): Queue {
        const queue = createJobsQueue(connection, name);
        queues.push(queue);
        return queue;
    }

    async function start(): Promise<void> {
        const persistQueue = registerQueue(JOB_QUEUES.boardPersistFlush);
        await upsertRepeatableJob(
            persistQueue,
            BOARD_PERSIST_FLUSH_JOB,
            runtime.config.boardPersistIntervalMs,
        );
        workers.push(
            createRepeatableWorker(JOB_QUEUES.boardPersistFlush, BOARD_PERSIST_FLUSH_JOB, async () =>
                runtime.boardPersistenceService.flushDirtyBoards(), connection),
        );

        const maintenanceQueue = registerQueue(JOB_QUEUES.boardMaintenance);
        await upsertRepeatableJob(
            maintenanceQueue,
            BOARD_CLEANUP_JOB,
            runtime.config.redisCleanupIntervalMs,
        );
        workers.push(
            createRepeatableWorker(JOB_QUEUES.boardMaintenance, BOARD_CLEANUP_JOB, async () => {
                const [flushed, transientDeleted] = await Promise.all([
                    runtime.redisCleanupService.cleanupInactiveBoards(),
                    runtime.redisCleanupService.cleanupTransientDataByIdleTime(),
                ]);
                return { flushed: flushed.length, transientDeleted: transientDeleted.length };
            }, connection),
        );
    }

    async function stop(): Promise<void> {
        await Promise.all(workers.map((worker) => worker.close()));
        workers.length = 0;
        await Promise.all(queues.map((queue) => queue.close()));
        queues.length = 0;
    }

    function getQueues(): Queue[] {
        return [...queues];
    }

    return { start, stop, getQueues };
}
