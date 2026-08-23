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
export const APP_EVENTS_STREAM_MAXLEN = 10_000;

export interface AppEventMap {
    [APP_EVENTS.BOARD_MUTATED]: { boardId: string }
    [APP_EVENTS.BOARD_EDITORS_LEFT]: { boardId: string }
}

export type AppEventName = keyof AppEventMap;
export type AppEventHandler<TEvent extends AppEventName> = (payload: AppEventMap[TEvent]) => void;

export interface AppEventBus {
    emit: <TEvent extends AppEventName>(event: TEvent, payload: AppEventMap[TEvent]) => void
    on: <TEvent extends AppEventName>(event: TEvent, handler: AppEventHandler<TEvent>) => () => void
}

export interface AppEventBusOptions {
    /** Enables the Redis Stream transport when provided. */
    redis?: Redis
    /** Consumer group name; processes sharing a group split deliveries. */
    consumerGroup?: string
}

function serializeEvent<TEvent extends AppEventName>(event: TEvent, payload: AppEventMap[TEvent]): string[] {
    return [
        'event', event,
        'data', JSON.stringify(payload),
    ];
}

function createStreamAppEventBus(redis: Redis, consumerGroup: string): AppEventBus {
    // One consumer per process, fanning out internally: separate consumers
    // within a group SPLIT deliveries, which would silently drop events
    // whose handler lives on another subscription of the same bus.
    const consumerName = `${consumerGroup}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    const handlersByEvent = new Map<string, Set<(payload: unknown) => void>>();
    let running = false;
    let loopStarted = false;

    async function ensureGroup(): Promise<void> {
        try {
            await redis.xgroup('CREATE', APP_EVENTS_STREAM_KEY, consumerGroup, '0', 'MKSTREAM');
        } catch (error) {
            // BUSYGROUP means another replica already created it — expected.
            if (!(error as Error).message.includes('BUSYGROUP')) {
                throw error;
            }
        }
    }

    async function readLoop(): Promise<void> {
        if (loopStarted) {
            return;
        }
        loopStarted = true;
        running = true;

        await ensureGroup();
        while (running) {
            try {
                const responses = await redis.xreadgroup(
                    'GROUP', consumerGroup, consumerName,
                    'COUNT', '16',
                    'BLOCK', '5000',
                    'STREAMS', APP_EVENTS_STREAM_KEY, '>',
                ) as Array<[string, Array<[string, string[]]>]> | null;
                if (!responses) {
                    continue;
                }
                for (const streamResponse of responses) {
                    for (const [entryId, fields] of streamResponse[1]) {
                        let event: string | null = null;
                        let rawData: string | null = null;
                        for (let i = 0; i < fields.length; i += 2) {
                            if (fields[i] === 'event') {
                                event = fields[i + 1] ?? null;
                            } else if (fields[i] === 'data') {
                                rawData = fields[i + 1] ?? null;
                            }
                        }

                        if (event && rawData) {
                            const handlers = handlersByEvent.get(event);
                            if (handlers) {
                                let payload: unknown;
                                try {
                                    payload = JSON.parse(rawData);
                                } catch (parseError) {
                                    logger.error({ err: parseError, event }, '[EventBus] stream payload parse failed');
                                }
                                if (payload !== undefined) {
                                    for (const handler of handlers) {
                                        try {
                                            handler(payload);
                                        } catch (handlerError) {
                                            logger.error({ err: handlerError, event }, '[EventBus] stream handler failed');
                                        }
                                    }
                                }
                            }
                        }

                        // Handler errors are logged but acked: retry loops
                        // belong to the underlying jobs, not this bus.
                        await redis.xack(APP_EVENTS_STREAM_KEY, consumerGroup, entryId);
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
                APP_EVENTS_STREAM_KEY,
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
            handlers.add(handler as (payload: unknown) => void);
            void readLoop();

            return () => {
                handlers?.delete(handler as (payload: unknown) => void);
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
        return createStreamAppEventBus(options.redis, options.consumerGroup ?? 'app-events');
    }
    return createInProcessAppEventBus();
}
