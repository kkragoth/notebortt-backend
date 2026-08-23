import { Queue, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { logger } from '@/shared/logger.js';

export const JOB_QUEUES = {
    boardPersistFlush: 'board-persist-flush',
    boardMaintenance: 'board-maintenance',
} as const;

export type JobQueueName = (typeof JOB_QUEUES)[keyof typeof JOB_QUEUES];

export const BOARD_PERSIST_FLUSH_JOB = 'flush-dirty-boards';
export const BOARD_CLEANUP_JOB = 'cleanup-inactive-boards';

const DEFAULT_JOB_ATTEMPTS = 3;
const DEFAULT_BACKOFF_DELAY_MS = 5_000;
const REMOVE_ON_COMPLETE_AGE_SECONDS = 24 * 60 * 60;
const REMOVE_ON_FAIL_AGE_SECONDS = 7 * 24 * 60 * 60;

export function createJobsQueue<TData>(connection: Redis, name: JobQueueName): Queue<TData> {
    return new Queue<TData>(name, {
        connection,
        defaultJobOptions: {
            attempts: DEFAULT_JOB_ATTEMPTS,
            backoff: {
                type: 'exponential',
                delay: DEFAULT_BACKOFF_DELAY_MS,
            },
            removeOnComplete: { age: REMOVE_ON_COMPLETE_AGE_SECONDS, count: 1_000 },
            removeOnFail: { age: REMOVE_ON_FAIL_AGE_SECONDS },
        },
    });
}

/**
 * Upsert semantics keyed by scheduler id: safe to call on every boot of every
 * replica; an interval change replaces the previous schedule instead of
 * stacking a second one (the classic repeatable-job deploy-drift bug).
 */
export async function upsertRepeatableJob<TData>(
    queue: Queue<TData>,
    jobSchedulerId: string,
    everyMs: number,
): Promise<void> {
    const scheduler = queue as unknown as Queue<string>;
    await scheduler.upsertJobScheduler(jobSchedulerId, { every: everyMs }, {
        name: jobSchedulerId,
        opts: {},
    });
}

export interface JobsWorkerHandle {
    name: string
    close: () => Promise<void>
}

export function createRepeatableWorker<TData>(
    queueName: JobQueueName,
    jobSchedulerId: string,
    processor: (data: TData) => Promise<unknown>,
    connection: Redis,
    onFailed?: (error: Error) => void,
): JobsWorkerHandle {
    const worker = new Worker<TData>(
        queueName,
        async (job) => {
            if (job.name !== jobSchedulerId) {
                return null;
            }
            return processor(job.data);
        },
        { connection, concurrency: 1 },
    );

    worker.on('failed', (job, err) => {
        logger.error({ err, queue: queueName, jobId: job?.id }, '[Jobs] repeatable job failed');
        onFailed?.(err);
    });
    worker.on('error', (err) => {
        logger.error({ err, queue: queueName }, '[Jobs] worker error');
    });

    return {
        name: `${queueName}:${jobSchedulerId}`,
        close: async () => {
            await worker.close();
        },
    };
}
