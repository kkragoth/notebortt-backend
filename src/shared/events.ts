import { Worker } from 'bullmq';
import { z } from 'zod';
import { logger } from './logger.js';
import type { Job, Queue } from 'bullmq';
import type Redis from 'ioredis';

/**
 * Cross-module domain events. Emitters must not know which module reacts;
 * subscribers are wired in the composition roots (src/apps/*).
 *
 * Two transports behind one interface:
 *   - in-process handlers (`local`; tests, single-process dev)
 *   - BullMQ queues (`bullmq`) for cross-process delivery between the
 *     api/realtime producers and the worker consumer. Delivery is
 *     at-least-once with retry/backoff; permanently undecodable payloads
 *     are parked on a dead-letter queue instead of being retried forever.
 */
export const APP_EVENTS = {
    /** Board state changed (REST mutation or realtime CRDT tick). */
    BOARD_MUTATED: 'board.mutated',
    /** Last editor left a board; consumers should flush pending work soon. */
    BOARD_EDITORS_LEFT: 'board.editorsLeft',
} as const;

export const APP_EVENT_SCHEMA_VERSION = 1;

export interface AppEventMap {
    [APP_EVENTS.BOARD_MUTATED]: { boardId: string }
    [APP_EVENTS.BOARD_EDITORS_LEFT]: { boardId: string }
}

export type AppEventName = keyof AppEventMap;
export type AppEventHandler<TEvent extends AppEventName> = (payload: AppEventMap[TEvent]) => void | Promise<void>;

export interface AppEventBus {
    /**
     * Resolves once the transport has durably accepted the event. Never
     * rejects: the triggering operation (mutation, tick, disconnect) is
     * already applied when emit runs, so an enqueue failure must degrade
     * delivery, not fail the primary result.
     */
    emit: <TEvent extends AppEventName>(event: TEvent, payload: AppEventMap[TEvent]) => Promise<void>
    on: <TEvent extends AppEventName>(event: TEvent, handler: AppEventHandler<TEvent>) => () => void
    /** Stops consumers (no-op on the local transport); idempotent. */
    close: () => Promise<void>
}

// ── envelope ─────────────────────────────────────────────────────────────

const appEventEnvelopeSchema = z.object({
    schemaVersion: z.number().int().min(1),
    producerId: z.string().min(1),
    timestamp: z.number().int().positive(),
    data: z.unknown(),
});

type AppEventEnvelope = z.infer<typeof appEventEnvelopeSchema>;

const boardRefPayloadSchema = z.object({ boardId: z.string().min(1) });

const payloadSchemas: Record<AppEventName, z.ZodType<AppEventMap[AppEventName]>> = {
    [APP_EVENTS.BOARD_MUTATED]: boardRefPayloadSchema,
    [APP_EVENTS.BOARD_EDITORS_LEFT]: boardRefPayloadSchema,
};

/** Body of a job on the domain-event transport queues. */
export interface DomainEventJobData {
    event: string
    envelope: unknown
}

export const DOMAIN_EVENTS_DLQ_JOB_NAME = 'dead-letter';

export const DOMAIN_EVENT_DLQ_REASONS = {
    invalidEnvelope: 'invalid_envelope',
    unknownSchemaVersion: 'unknown_schema_version',
    unknownEvent: 'unknown_event',
    invalidPayload: 'invalid_payload',
} as const;

export type DeadLetterReason = (typeof DOMAIN_EVENT_DLQ_REASONS)[keyof typeof DOMAIN_EVENT_DLQ_REASONS];

/** Parked on the dead-letter queue; never re-processed. */
export interface DeadLetterRecord {
    originalQueue: string | undefined
    originalJobId: string | undefined
    event: string
    reason: DeadLetterReason
    error: string | null
    envelope: unknown
}

export interface DomainEventQueueSet {
    mutations: Queue<DomainEventJobData>
    controlEvents: Queue<DomainEventJobData>
    dlq: Queue<DeadLetterRecord>
}

/** Consumer/producer view; the DLQ is only required on consumer processes. */
export interface AppEventBusQueues {
    mutations: Queue<DomainEventJobData>
    controlEvents: Queue<DomainEventJobData>
    dlq?: Queue<DeadLetterRecord>
}

// BullMQ forbids ":" inside deduplication ids; hyphens/dots are fine.
function deduplicationId(event: AppEventName, payload: { boardId?: string }): string {
    return `${event}-${payload.boardId ?? 'all'}`.replaceAll(':', '-');
}

function isAppEventName(value: unknown): value is AppEventName {
    return typeof value === 'string' && Object.values(APP_EVENTS).includes(value as AppEventName);
}

function formatIssues(error: z.ZodError): string {
    return error.issues.map((issue) => issue.message).join('; ');
}

// ── local transport (in-process handlers) ────────────────────────────────

function createInProcessAppEventBus(): AppEventBus {
    const handlersByEvent = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
    const warnedNoListeners = new Set<string>();

    return {
        async emit(event, payload) {
            const handlers = handlersByEvent.get(event);
            if (!handlers || handlers.size === 0) {
                if (!warnedNoListeners.has(event)) {
                    warnedNoListeners.add(event);
                    logger.warn({ event }, '[EventBus] emitted with no listeners');
                }
                return;
            }
            const results = await Promise.allSettled(
                [...handlers].map((handler) => Promise.resolve().then(() => handler(payload))),
            );
            for (const result of results) {
                if (result.status === 'rejected') {
                    logger.error({ err: result.reason, event }, '[EventBus] handler failed');
                }
            }
        },
        on(event, handler) {
            let handlers = handlersByEvent.get(event);
            if (!handlers) {
                handlers = new Set();
                handlersByEvent.set(event, handlers);
            }
            handlers.add(handler as (payload: unknown) => void | Promise<void>);
            return () => {
                handlers.delete(handler as (payload: unknown) => void | Promise<void>);
            };
        },
        async close() {
            warnedNoListeners.clear();
        },
    };
}

// ── bullmq transport (cross-process queues) ──────────────────────────────

const DEFAULT_CONSUMER_CONCURRENCY = 5;
const DEFAULT_DLQ_SUMMARY_INTERVAL_MS = 60_000;

/**
 * Fixed-window coalescing keyed on event+boardId: bursts collapse into one
 * queued trigger per window. Handlers read latest board state when they run
 * (preview renders debounce further), so collapsed duplicates carry no lost
 * information.
 */
const DEDUP_TTL_MS = {
    [APP_EVENTS.BOARD_MUTATED]: 2_000,
    [APP_EVENTS.BOARD_EDITORS_LEFT]: 1_000,
} as const satisfies Record<AppEventName, number>;

export interface AppEventEmitFailureInfo {
    event: AppEventName
    producerId: string
}

export interface AppEventJobFailureInfo {
    queue: string
    jobId: string | undefined
    event: string | undefined
    boardId: string | undefined
    error: Error
}

export type AppEventBusOptions = {
    transport?: 'local'
} | {
    transport: 'bullmq'
    connection: Redis
    /** Must match the prefix the queues were created with. */
    prefix?: string
    queues: AppEventBusQueues
    producerId: string
    /** Per-queue worker concurrency; pools stay isolated per queue. */
    consumerConcurrency?: number
    onEnqueueFailed?: (error: Error, info: AppEventEmitFailureInfo) => void
    onJobFailed?: (info: AppEventJobFailureInfo) => void
    dlqSummaryIntervalMs?: number
};

function boardIdOfEnvelope(envelope: unknown): string | undefined {
    const data = (envelope as { data?: { boardId?: unknown } } | null)?.data;
    return typeof data?.boardId === 'string' ? data.boardId : undefined;
}

function createBullMqAppEventBus(options: Extract<AppEventBusOptions, { transport: 'bullmq' }>): AppEventBus {
    const { connection, prefix, producerId, queues } = options;
    const concurrency = options.consumerConcurrency ?? DEFAULT_CONSUMER_CONCURRENCY;
    const dlqSummaryIntervalMs = options.dlqSummaryIntervalMs ?? DEFAULT_DLQ_SUMMARY_INTERVAL_MS;

    const handlersByEvent = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
    const workers: Array<Worker<DomainEventJobData> | Worker<DeadLetterRecord>> = [];
    let consumersStarted = false;

    const dlqWindow = { total: 0, byReason: new Map<string, number>(), sinceBoot: 0 };
    let dlqSummaryTimer: NodeJS.Timeout | undefined;

    function scheduleDlqSummary(): void {
        if (dlqSummaryTimer) {
            return;
        }
        dlqSummaryTimer = setTimeout(() => {
            dlqSummaryTimer = undefined;
            if (dlqWindow.total === 0) {
                return;
            }
            logger.warn({
                event: 'domain_events.dlq_summary',
                windowMs: dlqSummaryIntervalMs,
                total: dlqWindow.total,
                sinceBoot: dlqWindow.sinceBoot,
                byReason: Object.fromEntries(dlqWindow.byReason),
            }, '[EventBus] dead-letter summary');
            dlqWindow.total = 0;
            dlqWindow.byReason.clear();
        }, dlqSummaryIntervalMs);
        dlqSummaryTimer.unref();
    }

    function flushDlqSummary(): void {
        if (dlqSummaryTimer) {
            clearTimeout(dlqSummaryTimer);
            dlqSummaryTimer = undefined;
        }
        if (dlqWindow.total === 0) {
            return;
        }
        logger.warn({
            event: 'domain_events.dlq_summary',
            windowMs: null,
            total: dlqWindow.total,
            sinceBoot: dlqWindow.sinceBoot,
            byReason: Object.fromEntries(dlqWindow.byReason),
        }, '[EventBus] dead-letter summary');
        dlqWindow.total = 0;
        dlqWindow.byReason.clear();
    }

    async function parkDeadLetter(job: Job<DomainEventJobData>, reason: DeadLetterReason, error: string | null): Promise<void> {
        const record: DeadLetterRecord = {
            originalQueue: job.queueName,
            originalJobId: job.id,
            event: typeof job.data?.event === 'string' ? job.data.event : 'unknown',
            reason,
            error,
            envelope: job.data?.envelope ?? null,
        };
        dlqWindow.total += 1;
        dlqWindow.sinceBoot += 1;
        dlqWindow.byReason.set(reason, (dlqWindow.byReason.get(reason) ?? 0) + 1);
        scheduleDlqSummary();
        logger.error({
            event: 'domain_events.dead_letter',
            queue: record.originalQueue,
            jobId: record.originalJobId,
            domainEvent: record.event,
            reason,
            error,
            producerId: (record.envelope as AppEventEnvelope | null)?.producerId,
            schemaVersion: (record.envelope as AppEventEnvelope | null)?.schemaVersion,
        }, '[EventBus] domain event dead-lettered');

        const dlq = queues.dlq;
        if (!dlq) {
            logger.error({ reason }, '[EventBus] no DLQ queue wired; record not persisted');
            return;
        }
        await dlq.add(DOMAIN_EVENTS_DLQ_JOB_NAME, record, { attempts: 1 });
    }

    async function dispatch(event: AppEventName, payload: unknown): Promise<void> {
        const handlers = handlersByEvent.get(event);
        if (!handlers || handlers.size === 0) {
            return;
        }
        const results = await Promise.allSettled(
            [...handlers].map((handler) => Promise.resolve(handler(payload))),
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.error({ err: result.reason, event }, '[EventBus] handler failed');
                // Throw after fanning out to every handler so one failing
                // subscriber cannot starve the others; redelivery relies on
                // idempotent handlers (same contract as the previous bus).
                throw result.reason;
            }
        }
    }

    async function handleDomainEventJob(job: Job<DomainEventJobData>): Promise<void> {
        const parsedEnvelope = appEventEnvelopeSchema.safeParse(job.data?.envelope);
        if (!parsedEnvelope.success) {
            await parkDeadLetter(job, DOMAIN_EVENT_DLQ_REASONS.invalidEnvelope, formatIssues(parsedEnvelope.error));
            return;
        }
        const envelope = parsedEnvelope.data;
        if (envelope.schemaVersion !== APP_EVENT_SCHEMA_VERSION) {
            await parkDeadLetter(job, DOMAIN_EVENT_DLQ_REASONS.unknownSchemaVersion, `unsupported schemaVersion ${envelope.schemaVersion}`);
            return;
        }
        const event = job.data?.event;
        if (!isAppEventName(event)) {
            await parkDeadLetter(job, DOMAIN_EVENT_DLQ_REASONS.unknownEvent, `unknown event ${String(event)}`);
            return;
        }
        const payload = payloadSchemas[event].safeParse(envelope.data);
        if (!payload.success) {
            await parkDeadLetter(job, DOMAIN_EVENT_DLQ_REASONS.invalidPayload, formatIssues(payload.error));
            return;
        }
        await dispatch(event, payload.data);
    }

    function reportJobFailure(queueName: string, job: Job<DomainEventJobData> | Job<DeadLetterRecord> | undefined, err: Error): void {
        const info: AppEventJobFailureInfo = {
            queue: queueName,
            jobId: job?.id,
            event: typeof (job?.data)?.event === 'string'
                ? (job?.data as DomainEventJobData).event
                : undefined,
            boardId: boardIdOfEnvelope((job as Job<DomainEventJobData> | undefined)?.data?.envelope),
            error: err,
        };
        if (options.onJobFailed) {
            options.onJobFailed(info);
            return;
        }
        logger.error({ err: info.error, queue: info.queue, jobId: info.jobId, boardId: info.boardId }, '[EventBus] domain event job failed');
    }

    function startConsumers(): void {
        if (consumersStarted) {
            return;
        }
        consumersStarted = true;

        const workerOptions = { connection, ...(prefix ? { prefix } : {}), concurrency };
        for (const queue of [queues.mutations, queues.controlEvents]) {
            const worker = new Worker<DomainEventJobData>(
                queue.name,
                (job) => handleDomainEventJob(job),
                workerOptions,
            );
            worker.on('failed', (job, err) => reportJobFailure(queue.name, job, err));
            worker.on('error', (err) => logger.error({ err, queue: queue.name }, '[EventBus] consumer error'));
            workers.push(worker);
        }

        // Recorder-only worker: transitions parked records to completed so
        // the queue's removeOnComplete age is what bounds DLQ retention.
        const dlq = queues.dlq;
        if (dlq) {
            const recorder = new Worker<DeadLetterRecord>(
                dlq.name,
                async () => undefined,
                { connection, ...(prefix ? { prefix } : {}), concurrency: 1 },
            );
            recorder.on('failed', (job, err) => {
                logger.error({ err, queue: dlq.name, jobId: job?.id }, '[EventBus] DLQ recorder failed');
            });
            recorder.on('error', (err) => logger.error({ err, queue: dlq.name }, '[EventBus] DLQ recorder error'));
            workers.push(recorder);
        }
    }

    return {
        async emit(event, payload) {
            const queue = event === APP_EVENTS.BOARD_EDITORS_LEFT ? queues.controlEvents : queues.mutations;
            const envelope = {
                schemaVersion: APP_EVENT_SCHEMA_VERSION,
                producerId,
                timestamp: Date.now(),
                data: payload,
            };
            try {
                await queue.add(event, { event, envelope } satisfies DomainEventJobData, {
                    deduplication: {
                        id: deduplicationId(event, payload),
                        ttl: DEDUP_TTL_MS[event],
                    },
                });
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                logger.error({ err, event, producerId, queue: queue.name }, '[EventBus] enqueue failed (delivery degraded)');
                options.onEnqueueFailed?.(err, { event, producerId });
            }
        },
        on(event, handler) {
            let handlers = handlersByEvent.get(event);
            if (!handlers) {
                handlers = new Set();
                handlersByEvent.set(event, handlers);
            }
            handlers.add(handler as (payload: unknown) => void | Promise<void>);
            startConsumers();

            return () => {
                handlers.delete(handler as (payload: unknown) => void | Promise<void>);
            };
        },
        async close() {
            flushDlqSummary();
            const closing = workers.splice(0).map((worker) => worker.close());
            await Promise.all(closing);
        },
    };
}

export function createAppEventBus(options: AppEventBusOptions = {}): AppEventBus {
    if (options.transport === 'bullmq') {
        return createBullMqAppEventBus(options);
    }
    return createInProcessAppEventBus();
}
