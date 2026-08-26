import { Worker } from 'bullmq';
import Redis from 'ioredis';

// Subprocess fixture for the queue crash-recovery suite: picks up jobs,
// records its pid + attempt count in redis, and hangs forever unless the
// parent flips the behavior key to 'complete' (or 'fail' to exercise
// dead-lettering). The parent kills this process mid-processing.
//
// All signal keys are namespaced under CRASH_PREFIX so the parent's cleanup
// sweep (${PREFIX}:*) removes them — unprefixed keys would leak into the
// shared redis forever.
const url = process.env.CRASH_REDIS_URL ?? 'redis://localhost:6379';
const prefix = process.env.CRASH_PREFIX;
const queueName = process.env.CRASH_QUEUE;

if (!prefix || !queueName) {
    console.error('CRASH_PREFIX and CRASH_QUEUE are required');
    process.exit(1);
}

const signal = new Redis(url);
const connection = new Redis(url, { maxRetriesPerRequest: null });

function signalKey(kind, jobId) {
    return `${prefix}:crash:${kind}:${jobId}`;
}

const worker = new Worker(queueName, async (job) => {
    await signal.set(signalKey('started', job.id), String(process.pid));
    const behavior = await signal.get(signalKey('behavior', job.id));
    await signal.incr(signalKey('attempts', job.id));
    if (behavior === 'fail') {
        throw new Error('permanent failure');
    }
    if (behavior !== 'complete') {
        await new Promise(() => { });
    }
}, { connection, prefix, concurrency: 1, maxStalledCount: 3, lockDuration: 1_000 });

worker.on('error', (err) => {
    // stdio is inherited-ignored in CI, but this keeps child failures visible
    // in verbose runs instead of looking identical to a healthy hung handler.
    console.error('[crash-worker] worker error:', err);
});
