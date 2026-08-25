import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginRollbackTx, closeFixtures } from './helpers/fixtures.js';
import type { RollbackTxHandle } from './helpers/fixtures.js';
import { createBoardPersistenceDomain } from '@/modules/collaboration/board-state/persistence-domain.js';
import {
    DIRTY_BOARDS_BY_AGE_KEY,
    DIRTY_BOARDS_KEY,
    boardDeletedElementIdsKey,
    boardDirtyElementIdsKey,
    boardDirtyEpochKey,
    boardDirtySinceKey,
    boardElementsKey,
    boardLastFlushedSequenceKey,
    boardSeqKey,
} from '@/modules/collaboration/board-state/keys.js';
import { boards, elements, users, workspaceMembers, workspaces } from '@/platform/db/schema.js';

/**
 * Flush crash-boundary test (P6.3 / item 21 part 2): an interrupted flush
 * must never clear dirty markers (no lost writes), and the dirty-epoch guard
 * must reject stale clears so concurrent writers are never dropped.
 */

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';

const metricsStub = {
    incrementCounter: () => undefined,
    observeTiming: () => undefined,
    observeDuration: () => undefined,
    setGauge: () => undefined,
    logStructured: () => undefined,
    registerCollector: () => undefined,
    scrape: async () => ({ contentType: 'text/plain', body: '' }),
    getPromRegistry: () => ({} as never),
};

let redis: Redis;
const createdKeys: string[] = [];

function trackKey(key: string): string {
    createdKeys.push(key);
    return key;
}

function seedBoardState(boardId: string): void {
    const elementId = 'el-crash-1';
    const element = { id: elementId, kind: 'NOTE', x: 1, y: 2, zIndex: 3, updatedAt: Date.now() };
    void trackKey(boardSeqKey(boardId));
    void trackKey(boardElementsKey(boardId));
    void trackKey(boardDirtyEpochKey(boardId));
    void trackKey(boardDirtySinceKey(boardId));
    void trackKey(boardDirtyElementIdsKey(boardId));
    void trackKey(boardDeletedElementIdsKey(boardId));

    redis.pipeline()
        .set(boardSeqKey(boardId), '7')
        .hset(boardElementsKey(boardId), elementId, JSON.stringify(element))
        .set(boardDirtyEpochKey(boardId), '1')
        .set(boardDirtySinceKey(boardId), Date.now().toString())
        .sadd(boardDirtyElementIdsKey(boardId), elementId)
        .sadd(DIRTY_BOARDS_KEY, boardId)
        .zadd(DIRTY_BOARDS_BY_AGE_KEY, Date.now(), boardId)
        .exec();
}

async function isDirty(boardId: string): Promise<boolean> {
    const [inSet, since] = await Promise.all([
        redis.sismember(DIRTY_BOARDS_KEY, boardId),
        redis.get(boardDirtySinceKey(boardId)),
    ]);
    return inSet === 1 && since !== null;
}

/** db wrapper whose first `.transaction` call throws (simulated crash). */
function withFailingTransactions(db: RollbackTxHandle['db']) {
    let failed = false;
    return new Proxy(db, {
        get(target, prop, receiver) {
            if (prop === 'transaction') {
                return async (_callback: unknown) => {
                    if (!failed) {
                        failed = true;
                        throw new Error('simulated crash mid-flush');
                    }
                    return (Reflect.get(target, 'transaction', receiver) as (...args: unknown[]) => unknown).apply(target, [_callback]);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

/** db wrapper that delays inside `.transaction` so a concurrent epoch bump
 * deterministically lands between snapshot and clear. */
function withDelayedTransactions(db: RollbackTxHandle['db'], delayMs: number) {
    return new Proxy(db, {
        get(target, prop, receiver) {
            if (prop === 'transaction') {
                return async (callback: Parameters<RollbackTxHandle['db']['transaction']>[0]) => {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    return (Reflect.get(target, 'transaction', receiver) as (...args: unknown[]) => unknown).apply(target, [callback]);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

beforeAll(async () => {
    redis = new Redis(REDIS_URL);
});

afterAll(async () => {
    if (redis) {
        await redis.del(...createdKeys);
        await redis.quit();
    }
    await closeFixtures();
});

describe('flush crash boundaries', () => {
    it('keeps dirty markers when the flush crashes mid-write', async () => {
        const tx = await beginRollbackTx();
        const [user] = await tx.db.insert(users).values({
            email: `crash-${Date.now()}@example.com`,
            name: 'Crash Test',
        }).returning({ id: users.id });
        const [workspace] = await tx.db.insert(workspaces).values({
            name: 'crash-test',
            ownerId: user.id,
        }).returning({ id: workspaces.id });
        await tx.db.insert(workspaceMembers).values({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'owner',
        });
        const [board] = await tx.db.insert(boards).values({
            workspaceId: workspace.id,
            name: 'crash-board',
        }).returning({ id: boards.id });

        seedBoardState(board.id);

        const domain = createBoardPersistenceDomain(redis, withFailingTransactions(tx.db), {
            waitForBoardLoad: async () => undefined,
            getElements: async () => ({}),
            peekSequence: async () => Number(await redis.get(boardSeqKey(board.id)) ?? 0),
            metrics: metricsStub,
            enableIncrementalPersistence: true,
        });

        await expect(domain.persistBoard(board.id)).rejects.toThrow(/simulated crash/);

        // The interrupted flush must not have cleared anything.
        expect(await isDirty(board.id)).toBe(true);
        expect(await redis.get(boardLastFlushedSequenceKey(board.id))).toBeNull();

        // Retry on a healthy writer completes the flush.
        const healthy = createBoardPersistenceDomain(redis, tx.db, {
            waitForBoardLoad: async () => undefined,
            getElements: async () => ({}),
            peekSequence: async () => Number(await redis.get(boardSeqKey(board.id)) ?? 0),
            metrics: metricsStub,
            enableIncrementalPersistence: true,
        });
        await healthy.persistBoard(board.id);

        expect(await isDirty(board.id)).toBe(false);
        expect(await redis.get(boardLastFlushedSequenceKey(board.id))).toBe('7');
        const rows = await tx.db.select().from(elements);
        expect(rows.some((row) => row.id === 'el-crash-1')).toBe(true);

        await tx.rollback();
    }, 30_000);

    it('rejects marker clears whose dirty epoch moved during the flush', async () => {
        const tx = await beginRollbackTx();
        const [user] = await tx.db.insert(users).values({
            email: `epoch-${Date.now()}@example.com`,
            name: 'Epoch Test',
        }).returning({ id: users.id });
        const [workspace] = await tx.db.insert(workspaces).values({
            name: 'epoch-test',
            ownerId: user.id,
        }).returning({ id: workspaces.id });
        await tx.db.insert(workspaceMembers).values({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'owner',
        });
        const [board] = await tx.db.insert(boards).values({
            workspaceId: workspace.id,
            name: 'epoch-board',
        }).returning({ id: boards.id });

        seedBoardState(board.id);

        const domain = createBoardPersistenceDomain(redis, withDelayedTransactions(tx.db, 300), {
            waitForBoardLoad: async () => undefined,
            getElements: async () => ({}),
            peekSequence: async () => Number(await redis.get(boardSeqKey(board.id)) ?? 0),
            metrics: metricsStub,
            enableIncrementalPersistence: true,
        });

        const flushPromise = domain.persistBoard(board.id);
        // Lands inside the delayed transaction, after the epoch snapshot.
        await new Promise((resolve) => setTimeout(resolve, 50));
        await redis.set(boardDirtyEpochKey(board.id), '2');
        await flushPromise;

        // The stale snapshot must NOT clear the markers: the new dirty
        // window stays pending for the next flush.
        expect(await isDirty(board.id)).toBe(true);
        expect(await redis.get(boardLastFlushedSequenceKey(board.id))).toBeNull();

        // Next flush snapshots the new epoch and clears cleanly.
        await domain.persistBoard(board.id);
        expect(await isDirty(board.id)).toBe(false);
        expect(await redis.get(boardLastFlushedSequenceKey(board.id))).toBe('7');

        await tx.rollback();
    }, 30_000);
});
