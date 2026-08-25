import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Queue crash-recovery (P2b.2): a worker subprocess killed mid-processing
 * must not lose the job — BullMQ redelivers it to a surviving worker
 * (at-least-once), and a permanently failing job is dead-lettered into the
 * failed set with bounded retention.
 */

const REDIS_URL = process.env.REDIS_JOBS_URL ?? process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';
const PREFIX = `bull:crash-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
const QUEUE_NAME = 'board-mutations-crash-recovery';

interface CrashJobData {
    boardId?: string
}

const connections: Redis[] = [];
const workers: Worker[] = [];
const queues: Queue[] = [];
let crashedChildPid: number | undefined;

function makeConnection(): Redis {
    const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    connections.push(connection);
    return connection;
}

function makeQueue(): Queue<CrashJobData> {
    const queue = new Queue<CrashJobData>(QUEUE_NAME, {
        connection: makeConnection(),
        prefix: PREFIX,
        defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'fixed', delay: 100 },
            removeOnComplete: { age: 60 },
            removeOnFail: { age: 60 },
        },
    });
    queues.push(queue);
    return queue;
}

function makeWorker(): Worker<CrashJobData> {
    const signal = makeConnection();
    const worker = new Worker<CrashJobData>(
        QUEUE_NAME,
        async (job) => {
            await signal.set(`crash:started:${job.id}`, String(process.pid));
            const behavior = await signal.get(`crash:behavior:${job.id}`);
            await signal.incr(`crash:attempts:${job.id}`);
            if (behavior === 'fail') {
                throw new Error('permanent failure');
            }
            if (behavior !== 'complete') {
                await delay(30_000);
            }
        },
        {
            connection: makeConnection(),
            prefix: PREFIX,
            concurrency: 1,
            stalledInterval: 200,
            maxStalledCount: 3,
            lockDuration: 1_000,
        },
    );
    worker.on('error', () => undefined);
    workers.push(worker);
    return worker;
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await delay(100);
    }
    throw new Error('condition not met before timeout');
}

afterAll(async () => {
    if (crashedChildPid !== undefined) {
        try {
            process.kill(crashedChildPid, 'SIGKILL');
        } catch {
            // already gone
        }
    }
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(queues.map((queue) => queue.close()));
    for (const connection of connections.splice(0)) {
        connection.quit().catch(() => undefined);
    }
    const cleaner = new Redis(REDIS_URL);
    const keys = await cleaner.keys(`${PREFIX}:*`);
    if (keys.length > 0) {
        await cleaner.del(...keys);
    }
    cleaner.disconnect();
});

describe('queue crash recovery', () => {
    it('redelivers a job whose worker was killed mid-processing and dead-letters permanent failures', async () => {
        const signal = makeConnection();
        const queue = makeQueue();

        const child = spawn(process.execPath, ['test/helpers/crash-worker.mjs'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                CRASH_REDIS_URL: REDIS_URL,
                CRASH_PREFIX: PREFIX,
                CRASH_QUEUE: QUEUE_NAME,
            },
            stdio: 'ignore',
        });
        crashedChildPid = child.pid;
        // Give the child's worker time to connect; it registers no jobs yet.
        await delay(1_500);

        const crashJobId = 'redeliver-me';
        await queue.add('render', { boardId: 'b-crash' }, { jobId: crashJobId });

        // The child picked the job up and is hanging inside the handler.
        await waitFor(async () =>
            Boolean(await signal.get(`crash:started:${crashJobId}`)), 20_000);
        await waitFor(async () =>
            Number(await signal.get(`crash:attempts:${crashJobId}`)) >= 1, 10_000);

        // Kill the worker mid-processing: the job stays "active" for a dead
        // process until a survivor's stall checker redelivers it.
        process.kill(crashedChildPid, 'SIGKILL');
        crashedChildPid = undefined;

        // Survivor takes over; first redelivery completes normally.
        await signal.set(`crash:behavior:${crashJobId}`, 'complete');
        const survivor = makeWorker();
        void survivor;

        await waitFor(async () => {
            const job = await queue.getJob(crashJobId);
            return job ? await job.isCompleted() : false;
        }, 30_000);

        const attempts = Number(await signal.get(`crash:attempts:${crashJobId}`));
        expect(attempts).toBeGreaterThanOrEqual(2);

        // Permanent failure lands in the failed set (bounded by removeOnFail).
        const deadJobId = 'dead-letter-me';
        await signal.set(`crash:behavior:${deadJobId}`, 'fail');
        await queue.add('render', { boardId: 'b-dead' }, { jobId: deadJobId, attempts: 1 });

        await waitFor(async () => {
            const failed = await queue.getFailed();
            return failed.some((job) => job.id === deadJobId);
        }, 30_000);

        const deadJob = await queue.getJob(deadJobId);
        expect(deadJob ? await deadJob.isFailed() : false).toBe(true);
    }, 90_000);
});
