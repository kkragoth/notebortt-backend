import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoardPresenceDomain } from '@/modules/collaboration/board-state/presence-domain.js';
import {
    ACTIVE_BOARDS_KEY,
    COLLAB_MODE_COOLDOWN_MS,
    boardClientLeaseKey,
    boardClientsKey,
    boardCollabModeUntilKey,
    boardLastActiveKey,
    boardViewerSessionsKey,
} from '@/modules/collaboration/board-state/keys.js';

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';

const metricsStub = {
    incrementCounter: () => undefined,
    observeTiming: () => undefined,
    observeDuration: () => undefined,
    setGauge: () => undefined,
    logStructured: () => undefined,
    registerCollector: () => undefined,
    scrape: async () => ({ contentType: 'text/plain', body: '' }),
};

let redis: Redis;
let domain: ReturnType<typeof createBoardPresenceDomain>;
const boardsToClean: string[] = [];

beforeAll(async () => {
    redis = new Redis(REDIS_URL);
    // waitForBoardLoad is a no-op here: load state is irrelevant to these
    // assertions, only the collab marker / participant counts matter.
    domain = createBoardPresenceDomain(redis, { waitForBoardLoad: async () => undefined, metrics: metricsStub });
});

afterAll(async () => {
    for (const boardId of boardsToClean) {
        const members = await redis.smembers(boardClientsKey(boardId));
        await redis.del(
            boardCollabModeUntilKey(boardId),
            boardClientsKey(boardId),
            boardViewerSessionsKey(boardId),
            boardLastActiveKey(boardId),
            ...members.map((member) => boardClientLeaseKey(boardId, member)),
        );
        // trackClient/touchViewerSession add the board to the global active
        // index; leaving phantom ids behind would leak state across runs.
        await redis.srem(ACTIVE_BOARDS_KEY, boardId);
    }
    await redis.quit();
});

function trackedBoard(boardId: string): string {
    boardsToClean.push(boardId);
    return boardId;
}

describe('presence grace period re-arm', () => {
    it('extends an active collab marker on mutation re-arm', async () => {
        const boardId = trackedBoard(`rearm-active-${Date.now()}`);
        await redis.set(boardCollabModeUntilKey(boardId), (Date.now() + 1_000).toString(), 'PX', 1_000);

        await domain.rearmCollabModeIfActive(boardId);

        const ttl = await redis.pttl(boardCollabModeUntilKey(boardId));
        expect(ttl).toBeGreaterThan(COLLAB_MODE_COOLDOWN_MS - 5_000);
        expect(await domain.getSyncWriteMode(boardId)).toBe('collab');
    });

    it('does not flip a solo board to deferred persistence on mutation', async () => {
        const boardId = trackedBoard(`rearm-solo-${Date.now()}`);

        await domain.rearmCollabModeIfActive(boardId);

        expect(await redis.get(boardCollabModeUntilKey(boardId))).toBeNull();
        expect(await domain.getSyncWriteMode(boardId)).toBe('solo');
    });

    it('creates the marker only when two or more participants are active', async () => {
        const boardId = trackedBoard(`rearm-crowd-${Date.now()}`);
        await domain.trackClient(boardId, 'user-a', 'conn-1');

        await domain.rearmCollabModeIfActive(boardId);
        expect(await redis.get(boardCollabModeUntilKey(boardId))).toBeNull();

        await domain.trackClient(boardId, 'user-b', 'conn-2');
        await domain.rearmCollabModeIfActive(boardId);
        const ttl = await redis.pttl(boardCollabModeUntilKey(boardId));
        expect(ttl).toBeGreaterThan(0);
    });

    it('ping-only viewer traffic never creates the marker', async () => {
        const boardId = trackedBoard(`rearm-ping-${Date.now()}`);
        await domain.touchViewerSession(boardId, 'viewer-session-1');

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await redis.get(boardCollabModeUntilKey(boardId))).toBeNull();
        expect(await domain.getSyncWriteMode(boardId)).toBe('solo');
    });

    it('downgrades to solo after marker expiry with fewer than two editors', async () => {
        const boardId = trackedBoard(`rearm-expiry-${Date.now()}`);
        await redis.set(boardCollabModeUntilKey(boardId), Date.now().toString(), 'PX', 5);
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(await redis.get(boardCollabModeUntilKey(boardId))).toBeNull();
        expect(await domain.getSyncWriteMode(boardId)).toBe('solo');
        // A post-apply re-arm must not resurrect an expired collab window
        // for a board that is back in solo mode.
        await domain.rearmCollabModeIfActive(boardId);
        expect(await redis.get(boardCollabModeUntilKey(boardId))).toBeNull();
    });
});
