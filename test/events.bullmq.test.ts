import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEventBus, DeadLetterRecord, DomainEventJobData } from '@/shared/events.js';
import {
    APP_EVENTS,
    DOMAIN_EVENTS_DLQ_JOB_NAME,
    createAppEventBus,
} from '@/shared/events.js';

const REDIS_URL = process.env.REDIS_JOBS_URL ?? process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';

// Unique BullMQ key namespace per run so parallel suites and stale state
// cannot interfere.
const PREFIX = `bull:events-test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

const FAST_JOB_DEFAULTS = {
    attempts: 4,
    backoff: { type: 'fixed', delay: 50 } as const,
    removeOnComplete: { age: 60 },
    removeOnFail: { age: 60 },
};

const connections: Redis[] = [];
const queues: Queue[] = [];
const buses: AppEventBus[] = [];

function makeConnection(): Redis {
    const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    connections.push(connection);
    return connection;
}

function makeQueue<TData>(name: string, defaultJobOptions: Record<string, unknown>): Queue<TData> {
    const queue = new Queue<TData>(name, {
        connection: makeConnection(),
        prefix: PREFIX,
        defaultJobOptions,
    });
    queues.push(queue);
    return queue;
}

interface BusHarnessOptions {
    onEnqueueFailed?: (error: Error) => void
    onJobFailed?: (info: { queue: string; jobId: string | undefined }) => void
}

function makeBus({ onEnqueueFailed, onJobFailed }: BusHarnessOptions = {}): AppEventBus {
    // Each bus re-opens the named queues under the run prefix; producers and
    // consumers in these tests share one redis like one deployment would.
    const bus = createAppEventBus({
        transport: 'bullmq',
        connection: makeConnection(),
        prefix: PREFIX,
        queues: {
            mutations: makeQueue<DomainEventJobData>('board-mutations', FAST_JOB_DEFAULTS),
            controlEvents: makeQueue<DomainEventJobData>('board-control-events', FAST_JOB_DEFAULTS),
            dlq: makeQueue<DeadLetterRecord>('domain-events-dlq', {
                attempts: 1,
                removeOnComplete: { age: 60 },
                removeOnFail: { age: 60 },
            }),
        },
        producerId: 'test-producer',
        consumerConcurrency: 5,
        ...(onEnqueueFailed ? { onEnqueueFailed } : {}),
        ...(onJobFailed ? { onJobFailed } : {}),
        dlqSummaryIntervalMs: 50,
    });
    buses.push(bus);
    return bus;
}

async function dlqRecords(): Promise<Array<Record<string, unknown>>> {
    const dlq = queues.find((queue) => queue.name === 'domain-events-dlq') as Queue<DeadLetterRecord> | undefined;
    if (!dlq) {
        return [];
    }
    const jobs = await dlq.getJobs(['completed', 'waiting']);
    return jobs.filter(Boolean).map((job) => job.data as unknown as Record<string, unknown>);
}

afterEach(async () => {
    for (const bus of buses.splice(0)) {
        await bus.close();
    }
});

afterAll(async () => {
    await Promise.all(queues.map((queue) => queue.close()));
    queues.length = 0;
    for (const connection of connections.splice(0)) {
        connection.quit().catch(() => undefined);
    }
    const cleaner = new Redis(REDIS_URL);
    const staleKeys = await cleaner.keys(`${PREFIX}:*`);
    if (staleKeys.length > 0) {
        await cleaner.del(...staleKeys);
    }
    cleaner.disconnect();
});

describe('bullmq-backed app event bus', () => {
    it('delivers emitted events to a subscriber registered on another bus instance', async () => {
        const producer = makeBus();
        const consumer = makeBus();
        const handler = vi.fn().mockResolvedValue(undefined);
        consumer.on(APP_EVENTS.BOARD_MUTATED, handler);

        await producer.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-1' });

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith({ boardId: 'b-1' });
        }, { timeout: 15_000 });
    });

    it('fans out one delivery to every handler registered on the same bus', async () => {
        const producer = makeBus();
        const consumer = makeBus();
        const first = vi.fn().mockResolvedValue(undefined);
        const second = vi.fn().mockResolvedValue(undefined);
        consumer.on(APP_EVENTS.BOARD_EDITORS_LEFT, first);
        consumer.on(APP_EVENTS.BOARD_EDITORS_LEFT, second);

        await producer.emit(APP_EVENTS.BOARD_EDITORS_LEFT, { boardId: 'b-2' });

        await vi.waitFor(() => {
            expect(first).toHaveBeenCalledWith({ boardId: 'b-2' });
            expect(second).toHaveBeenCalledWith({ boardId: 'b-2' });
        }, { timeout: 15_000 });
    });

    it('retries failed deliveries with backoff before succeeding', async () => {
        const producer = makeBus();
        const consumer = makeBus({
            onJobFailed: vi.fn(),
        });
        let failures = 2;
        const flaky = vi.fn(async () => {
            if (failures > 0) {
                failures -= 1;
                throw new Error('transient');
            }
        });
        consumer.on(APP_EVENTS.BOARD_MUTATED, flaky);

        await producer.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-retry' });

        await vi.waitFor(() => {
            expect(flaky.mock.calls.length).toBeGreaterThanOrEqual(3);
        }, { timeout: 15_000 });
        // Retried events must not leak into the DLQ.
        expect(await dlqRecords()).toHaveLength(0);
    });

    it('processes control events even while a mutation batch is still in flight', async () => {
        const producer = makeBus();
        const consumer = makeBus();

        let releaseSlowMutation: (() => void) | undefined;
        const slowGate = new Promise<void>((resolve) => {
            releaseSlowMutation = resolve;
        });
        const mutations = vi.fn(async ({ boardId }: { boardId: string }) => {
            if (boardId === 'b-slow') {
                await slowGate;
            }
        });
        const flushes = vi.fn().mockResolvedValue(undefined);
        consumer.on(APP_EVENTS.BOARD_MUTATED, mutations);
        consumer.on(APP_EVENTS.BOARD_EDITORS_LEFT, flushes);

        await producer.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-slow' });
        await vi.waitFor(() => {
            expect(mutations).toHaveBeenCalledTimes(1);
        }, { timeout: 15_000 });

        await producer.emit(APP_EVENTS.BOARD_EDITORS_LEFT, { boardId: 'b-slow' });
        await vi.waitFor(() => {
            expect(flushes).toHaveBeenCalledWith({ boardId: 'b-slow' });
        }, { timeout: 5_000 });

        releaseSlowMutation?.();
    });

    it('parks undecodable envelopes on the DLQ instead of retrying them', async () => {
        const producer = makeBus();
        const consumer = makeBus();
        const handler = vi.fn().mockResolvedValue(undefined);
        consumer.on(APP_EVENTS.BOARD_MUTATED, handler);

        const mutationsQueue = queues.find((queue) => queue.name === 'board-mutations') as Queue<DomainEventJobData>;
        await mutationsQueue.add(APP_EVENTS.BOARD_MUTATED, {
            event: APP_EVENTS.BOARD_MUTATED,
            envelope: { schemaVersion: 1 },
        });

        await vi.waitFor(async () => {
            const records = await dlqRecords();
            expect(records).toHaveLength(1);
            expect(records[0].reason).toBe('invalid_envelope');
            expect(records[0].event).toBe(APP_EVENTS.BOARD_MUTATED);
        }, { timeout: 15_000 });
        expect(handler).not.toHaveBeenCalled();
    });

    it('parks envelopes with an unsupported schemaVersion on the DLQ', async () => {
        const producer = makeBus();
        const consumer = makeBus();
        const handler = vi.fn().mockResolvedValue(undefined);
        consumer.on(APP_EVENTS.BOARD_MUTATED, handler);

        const mutationsQueue = queues.find((queue) => queue.name === 'board-mutations') as Queue<DomainEventJobData>;
        await mutationsQueue.add(APP_EVENTS.BOARD_MUTATED, {
            event: APP_EVENTS.BOARD_MUTATED,
            envelope: {
                schemaVersion: 99,
                producerId: 'future-app',
                timestamp: Date.now(),
                data: { boardId: 'b-future' },
            },
        });

        await vi.waitFor(async () => {
            const records = await dlqRecords();
            expect(records.filter((record) => record.reason === 'unknown_schema_version')).toHaveLength(1);
            expect(records.find((record) => record.reason === 'unknown_schema_version')?.envelope).toMatchObject({ schemaVersion: 99 });
        }, { timeout: 15_000 });
        expect(handler).not.toHaveBeenCalled();
    });

    it('records DLQ jobs under the dead-letter job name without retrying them', async () => {
        const producer = makeBus();
        const consumer = makeBus();
        consumer.on(APP_EVENTS.BOARD_EDITORS_LEFT, vi.fn().mockResolvedValue(undefined));

        const controlQueue = queues.find((queue) => queue.name === 'board-control-events') as Queue<DomainEventJobData>;
        await controlQueue.add('not-an-event', {
            event: 'not-an-event',
            envelope: { schemaVersion: 1, producerId: 'x', timestamp: Date.now(), data: {} },
        });

        await vi.waitFor(async () => {
            const records = await dlqRecords();
            expect(records.filter((record) => record.reason === 'unknown_event')).toHaveLength(1);
        }, { timeout: 15_000 });

        const dlq = queues.find((queue) => queue.name === 'domain-events-dlq') as Queue<DeadLetterRecord>;
        const jobs = await dlq.getJobs(['completed']);
        expect(jobs.every((job) => job.name === DOMAIN_EVENTS_DLQ_JOB_NAME)).toBe(true);
    });

    it('resolves emit even when the transport enqueue fails and reports the failure', async () => {
        const onEnqueueFailed = vi.fn();
        const failingQueue = {
            name: 'board-mutations',
            add: vi.fn(async () => {
                throw new Error('redis down');
            }),
        };
        const bus = createAppEventBus({
            transport: 'bullmq',
            connection: makeConnection(),
            prefix: PREFIX,
            queues: {
                mutations: failingQueue as unknown as Queue<DomainEventJobData>,
                controlEvents: failingQueue as unknown as Queue<DomainEventJobData>,
            },
            producerId: 'test-producer',
            onEnqueueFailed,
        });
        buses.push(bus);

        await expect(bus.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-fail' })).resolves.toBeUndefined();
        expect(onEnqueueFailed).toHaveBeenCalledTimes(1);
        expect(onEnqueueFailed.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(onEnqueueFailed.mock.calls[0][1]).toEqual({ event: APP_EVENTS.BOARD_MUTATED, producerId: 'test-producer' });
    });

    it('coalesces bursts of identical triggers into one queued job per dedup window', async () => {
        const producer = makeBus();
        const consumer = makeBus();
        const handler = vi.fn().mockResolvedValue(undefined);
        consumer.on(APP_EVENTS.BOARD_MUTATED, handler);

        await Promise.all([
            producer.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-burst' }),
            producer.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-burst' }),
            producer.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-burst' }),
        ]);

        const mutationsQueue = queues.find((queue) => queue.name === 'board-mutations') as Queue<DomainEventJobData>;
        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledTimes(1);
        }, { timeout: 15_000 });
        const counts = await mutationsQueue.getJobCounts('waiting', 'delayed');
        expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(0);
    });
});

describe('local app event bus', () => {
    it('awaits handlers before resolving and keeps handler failures non-fatal', async () => {
        const bus = createAppEventBus();
        buses.push(bus);
        const order: string[] = [];

        bus.on(APP_EVENTS.BOARD_MUTATED, () => {
            order.push('first');
        });
        bus.on(APP_EVENTS.BOARD_MUTATED, async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('second');
        });
        bus.on(APP_EVENTS.BOARD_MUTATED, () => {
            throw new Error('handler boom');
        });

        await expect(bus.emit(APP_EVENTS.BOARD_MUTATED, { boardId: 'b-local' })).resolves.toBeUndefined();
        expect(order).toEqual(['first', 'second']);
    });
});
