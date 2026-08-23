import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import type Redis from 'ioredis';

/**
 * Cross-module domain events. Emitters must not know which module reacts;
 * subscribers are wired in the composition roots (src/apps/*).
 *
 * Two transports behind one interface:
 *   - in-process EventEmitter (default; tests, single-process dev)
 *   - Redis Stream (`redis` option) for cross-process delivery between the
 *     api / realtime / worker apps. At-least-once: handlers must be idempotent
 *     (preview enqueues already dedup by board id).
 */
export const APP_EVENTS = {
    /** Board state changed (REST mutation or realtime CRDT tick). */
    BOARD_MUTATED: 'board.mutated',
    /** Last editor left a board; consumers should flush pending work soon. */
    BOARD_EDITORS_LEFT: 'board.editorsLeft',
} as const;

export const APP_EVENTS_STREAM_KEY = 'events:app';
/**
 * Approximate cap: under sustained burst older events are trimmed, so a
 * worker offline longer than ~MAXLEN events loses those triggers. Preview
 * generation self-heals on the next mutation; flush-on-editors-left does not.
 */
export const APP_EVENTS_STREAM_MAXLEN = 10_000;

export interface AppEventMap {
    [APP_EVENTS.BOARD_MUTATED]: { boardId: string }
    [APP_EVENTS.BOARD_EDITORS_LEFT]: { boardId: string }
}

export type AppEventName = keyof AppEventMap;
export type AppEventHandler<TEvent extends AppEventName> = (payload: AppEventMap[TEvent]) => void | Promise<void>;

export interface AppEventBus {
    emit: <TEvent extends AppEventName>(event: TEvent, payload: AppEventMap[TEvent]) => void
    on: <TEvent extends AppEventName>(event: TEvent, handler: AppEventHandler<TEvent>) => () => void
}

export interface AppEventBusOptions {
    /** Enables the Redis Stream transport when provided. */
    redis?: Redis
    /** Consumer group name; processes sharing a group split deliveries. */
    consumerGroup?: string
    /** Min idle time before a pending entry is reclaimed from a dead consumer. */
    reclaimMinIdleMs?: number
    /** How often the reclaim sweep runs. */
    reclaimIntervalMs?: number
    /** Overrides the stream key (tests / multi-tenant isolation). */
    streamKey?: string
}

function serializeEvent<TEvent extends AppEventName>(event: TEvent, payload: AppEventMap[TEvent]): string[] {
    return [
        'event', event,
        'data', JSON.stringify(payload),
    ];
}

const RECLAIM_MAX_ATTEMPTS = 5;

interface StreamBusRuntimeOptions {
    streamKey: string
    consumerGroup: string
    reclaimMinIdleMs: number
    reclaimIntervalMs: number
}

function createStreamAppEventBus(redis: Redis, runtimeOpts: StreamBusRuntimeOptions): AppEventBus {
    const { consumerGroup, reclaimMinIdleMs, reclaimIntervalMs } = runtimeOpts;
    // One consumer per process, fanning out internally: separate consumers
    // within a group SPLIT deliveries, which would silently drop events
    // whose handler lives on another subscription of the same bus.
    const consumerName = `${consumerGroup}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    const handlersByEvent = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
    // entryId -> failed processing attempts; poison entries are dropped
    // (XDEL + ack) after RECLAIM_MAX_ATTEMPTS so the PEL cannot clog forever.
    const failedAttemptsByEntry = new Map<string, number>();
    let running = false;
    let loopStarted = false;

    // Blocking reads (XREADGROUP BLOCK / slow reclaims) must never share a
    // connection with publishes: Redis executes commands per-connection in
    // order, so a BLOCK would stall every emit behind it for its full
    // timeout. The reader owns its own connection.
    const reader = redis.duplicate();
    reader.on('error', (err) => {
        logger.error({ err }, '[EventBus] reader connection error');
    });

    async function ensureGroup(): Promise<void> {
        try {
            // '$' = only entries added AFTER group creation are consumed.
            // Fresh deploys must not replay up to MAXLEN historical events.
            await redis.xgroup('CREATE', runtimeOpts.streamKey, consumerGroup, '$', 'MKSTREAM');
        } catch (error) {
            // BUSYGROUP means another replica already created it — expected.
            if (!(error as Error).message.includes('BUSYGROUP')) {
                throw error;
            }
        }
    }

    async function dispatch(entryId: string, fields: string[]): Promise<boolean> {
        let event: string | null = null;
        let rawData: string | null = null;
        for (let i = 0; i < fields.length; i += 2) {
            if (fields[i] === 'event') {
                event = fields[i + 1] ?? null;
            } else if (fields[i] === 'data') {
                rawData = fields[i + 1] ?? null;
            }
        }

        if (!event || !rawData) {
            return true;
        }

        const handlers = handlersByEvent.get(event);
        if (!handlers || handlers.size === 0) {
            return true;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(rawData);
        } catch (parseError) {
            logger.error({ err: parseError, event }, '[EventBus] stream payload parse failed');
            return true;
        }

        const results = await Promise.allSettled(
            [...handlers].map((handler) => Promise.resolve(handler(payload))),
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.error({ err: result.reason, event }, '[EventBus] stream handler failed');
                return false;
            }
        }
        return true;
    }

    async function processEntry(entryId: string, fields: string[]): Promise<void> {
        // Await handlers before acking so transient downstream failures
        // (e.g. jobs-redis blip during a preview enqueue) keep the entry in
        // the pending list for redelivery instead of being lost.
        const ok = await dispatch(entryId, fields);
        if (ok) {
            failedAttemptsByEntry.delete(entryId);
            await redis.xack(runtimeOpts.streamKey, consumerGroup, entryId);
            return;
        }

        const attempts = (failedAttemptsByEntry.get(entryId) ?? 0) + 1;
        failedAttemptsByEntry.set(entryId, attempts);
        if (attempts >= RECLAIM_MAX_ATTEMPTS) {
            logger.error({ event: 'eventbus.poison_dropped', entryId, attempts }, '[EventBus] dropping poison entry');
            failedAttemptsByEntry.delete(entryId);
            await redis.xdel(runtimeOpts.streamKey, entryId);
            await redis.xack(runtimeOpts.streamKey, consumerGroup, entryId);
        }
    }

    async function reclaimPending(): Promise<void> {
        try {
            // Reclaims run on the main connection: they must not queue
            // behind the reader's blocking XREADGROUP.
            const result = await redis.xautoclaim(
                runtimeOpts.streamKey,
                consumerGroup,
                consumerName,
                reclaimMinIdleMs,
                '0',
                'COUNT',
                16,
            ) as unknown;
            // Reply shape: [nextStartId, [[entryId, [f, v, ...]], ...], [deletedIds?]]
            const entries = Array.isArray(result) && Array.isArray(result[1])
                ? result[1] as Array<[string, string[]]>
                : [];
            for (const [entryId, fields] of entries) {
                await processEntry(entryId, fields);
            }
        } catch (reclaimError) {
            // NOGROUP before first group creation is expected on fresh keys.
            if (!(reclaimError as Error).message.includes('NOGROUP')) {
                logger.error({ err: reclaimError }, '[EventBus] reclaim sweep failed');
            }
        }
    }

    async function readLoop(): Promise<void> {
        if (loopStarted) {
            return;
        }
        loopStarted = true;
        running = true;

        // A previous full-unsubscribe cycle disconnected the reader.
        if (reader.status === 'end') {
            reader.connect();
        }

        void setInterval(() => {
            if (running) {
                void reclaimPending();
            }
        }, reclaimIntervalMs).unref();

        while (running) {
            try {
                // Retried every iteration: a transient redis error at startup
                // must not escape and crash the process (unhandled rejection).
                await ensureGroup();

                const responses = await reader.xreadgroup(
                    'GROUP', consumerGroup, consumerName,
                    'COUNT', '16',
                    'BLOCK', '5000',
                    'STREAMS', runtimeOpts.streamKey, '>',
                ) as Array<[string, Array<[string, string[]]>]> | null;

                for (const streamResponse of responses ?? []) {
                    for (const [entryId, fields] of streamResponse[1]) {
                        await processEntry(entryId, fields);
                    }
                }
            } catch (readError) {
                logger.error({ err: readError }, '[EventBus] stream read failed');
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
        }
    }

    return {
        emit(event, payload) {
            void redis.xadd(
                runtimeOpts.streamKey,
                'MAXLEN', '~', APP_EVENTS_STREAM_MAXLEN.toString(),
                '*',
                ...serializeEvent(event, payload),
            ).catch((error) => {
                logger.error({ err: error, event }, '[EventBus] stream publish failed');
            });
        },
        on<TEvent extends AppEventName>(event: TEvent, handler: AppEventHandler<TEvent>) {
            let handlers = handlersByEvent.get(event);
            if (!handlers) {
                handlers = new Set();
                handlersByEvent.set(event, handlers);
            }
            handlers.add(handler as (payload: unknown) => void | Promise<void>);
            void readLoop();

            return () => {
                handlers?.delete(handler as (payload: unknown) => void | Promise<void>);
                let remaining = 0;
                for (const set of handlersByEvent.values()) {
                    remaining += set.size;
                }
                if (remaining === 0) {
                    running = false;
                    // Allow a future on() to restart the read loop cleanly.
                    loopStarted = false;
                    // Give an in-flight BLOCK up to one cycle to drain before
                    // tearing the reader connection down.
                    setTimeout(() => {
                        if (!running && handlersByEvent.size === 0) {
                            reader.disconnect();
                        }
                    }, 6_000).unref();
                }
            };
        },
    };
}

function createInProcessAppEventBus(): AppEventBus {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);

    return {
        emit(event, payload) {
            if (emitter.listenerCount(event) === 0) {
                logger.warn({ event }, '[EventBus] emitted with no listeners');
                return;
            }
            emitter.emit(event, payload);
        },
        on(event, handler) {
            const wrapped = (payload: AppEventMap[typeof event]) => {
                try {
                    handler(payload);
                } catch (err) {
                    logger.error({ err, event }, '[EventBus] sync handler failed');
                }
            };
            emitter.on(event, wrapped);
            return () => emitter.off(event, wrapped);
        },
    };
}

export function createAppEventBus(options: AppEventBusOptions = {}): AppEventBus {
    if (options.redis) {
        return createStreamAppEventBus(options.redis, {
            streamKey: options.streamKey ?? APP_EVENTS_STREAM_KEY,
            consumerGroup: options.consumerGroup ?? 'app-events',
            reclaimMinIdleMs: options.reclaimMinIdleMs ?? 30_000,
            reclaimIntervalMs: options.reclaimIntervalMs ?? 60_000,
        });
    }
    return createInProcessAppEventBus();
}
