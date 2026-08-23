import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

/**
 * Cross-module domain events. Emitters must not know which module reacts;
 * subscribers are wired in the composition root (src/app/runtime.ts).
 * Keep payloads small and serializable.
 */
export const APP_EVENTS = {
    /** Board state changed (REST mutation or realtime CRDT tick). */
    BOARD_MUTATED: 'board.mutated',
    /** Last editor left a board; consumers should flush pending work soon. */
    BOARD_EDITORS_LEFT: 'board.editorsLeft',
} as const;

export interface AppEventMap {
    [APP_EVENTS.BOARD_MUTATED]: { boardId: string }
    [APP_EVENTS.BOARD_EDITORS_LEFT]: { boardId: string }
}

export type AppEventHandler<TEvent extends keyof AppEventMap> = (payload: AppEventMap[TEvent]) => void;

export interface AppEventBus {
    emit: <TEvent extends keyof AppEventMap>(event: TEvent, payload: AppEventMap[TEvent]) => void
    on: <TEvent extends keyof AppEventMap>(event: TEvent, handler: AppEventHandler<TEvent>) => () => void
}

export function createAppEventBus(): AppEventBus {
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
