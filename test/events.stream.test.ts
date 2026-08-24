import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    APP_EVENTS,
    APP_EVENTS_STREAM_KEY,
    createAppEventBus,
} from '@/shared/events.js';

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';

// Unique key per run so parallel suites and stale groups cannot interfere.
const streamKey = `${APP_EVENTS_STREAM_KEY}:test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

describe('stream-backed app event bus', () => {
    let clients: Redis[] = [];
    let unsubscribes: Array<() => void> = [];

    beforeEach(() => {
        clients = [];
        unsubscribes = [];
    });

    afterEach(async () => {
        // Stop read loops before killing connections so pending BLOCKs
        // don't reject into the void as unhandled errors.
        for (const off of unsubscribes.splice(0)) {
            off();
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        const cleaner = new Redis(REDIS_URL);
        await cleaner.del(streamKey);
        cleaner.disconnect();
        for (const client of clients.splice(0)) {
            client.quit().catch(() => undefined);
        }
    });

    function trackUnsubscribe(off: () => void): void {
        unsubscribes.push(off);
    }

    function makeClient(): Redis {
        const client = new Redis(REDIS_URL);
        clients.push(client);
        return client;
    }

    function makeBus(group: string, overrides: Record<string, number | string> = {}) {
        return createAppEventBus({
            redis: makeClient(),
            consumerGroup: group,
            streamKey,
            reclaimMinIdleMs: 50,
            reclaimIntervalMs: 50,
            ...overrides,
        });
    }

    // Groups start at '$' (new entries only), so the key+group must exist
    // before anything is emitted — same as production where api publishes
    // long before a worker's first boot.
    async function precreateGroup(group: string): Promise<void> {
        const setup = makeClient();
        await setup.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
        setup.disconnect();
    }

    it('delivers emitted events to a subscriber in another process simulation', async () => {
        // Pre-create the group so '$' semantics apply relative to now, then
        // publish via a second connection like the api app would.
        const group = `g-${Math.random().toString(36).slice(2, 8)}`;
        const setup = makeClient();
        await setup.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
        setup.disconnect();

        const bus = makeBus(group);
        const handler = vi.fn().mockResolvedValue(undefined);
        trackUnsubscribe(bus.on(APP_EVENTS.BOARD_MUTATED, handler));

        await new Promise((resolve) => setTimeout(resolve, 100));

        const publisher = makeClient();
        await publisher.xadd(streamKey, '*', 'event', APP_EVENTS.BOARD_MUTATED, 'data', JSON.stringify({ boardId: 'b-1' }));

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith({ boardId: 'b-1' });
        }, { timeout: 15_000 });
    });

    it('fans out one delivery to every handler registered on the same bus', async () => {
        const group = `g-${Math.random().toString(36).slice(2, 8)}`;
        await precreateGroup(group);
        const bus = makeBus(group);
        const first = vi.fn().mockResolvedValue(undefined);
        const second = vi.fn().mockResolvedValue(undefined);
        trackUnsubscribe(bus.on(APP_EVENTS.BOARD_EDITORS_LEFT, first));
        trackUnsubscribe(bus.on(APP_EVENTS.BOARD_EDITORS_LEFT, second));

        await new Promise((resolve) => setTimeout(resolve, 100));
        bus.emit(APP_EVENTS.BOARD_EDITORS_LEFT, { boardId: 'b-2' });

        await vi.waitFor(() => {
            expect(first).toHaveBeenCalledWith({ boardId: 'b-2' });
            expect(second).toHaveBeenCalledWith({ boardId: 'b-2' });
        }, { timeout: 15_000 });
    });

    it('redelivers entries whose handler failed instead of losing them', async () => {
        const group = `g-${Math.random().toString(36).slice(2, 8)}`;
        await precreateGroup(group);
        const bus = makeBus(group);

        let failFirstCalls = true;
        const flaky = vi.fn(async () => {
            if (failFirstCalls) {
                throw new Error('transient');
            }
        });
        const healthy = vi.fn().mockResolvedValue(undefined);
        trackUnsubscribe(bus.on(APP_EVENTS.BOARD_MUTATED, flaky));
        trackUnsubscribe(bus.on(APP_EVENTS.BOARD_MUTATED, healthy));
        void bus;

        await new Promise((resolve) => setTimeout(resolve, 100));

        const publisher = makeClient();
        await publisher.xadd(streamKey, '*', 'event', APP_EVENTS.BOARD_MUTATED, 'data', JSON.stringify({ boardId: 'b-3' }));

        // First delivery fails (entry stays pending); the reclaim sweep
        // redelivers it, by which time the handler succeeds.
        await vi.waitFor(() => {
            expect(flaky.mock.calls.length).toBeGreaterThanOrEqual(2);
        }, { timeout: 15_000 });
        failFirstCalls = false;
    });
});
