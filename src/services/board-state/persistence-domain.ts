import { and, eq, inArray, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Database } from '@/db/client.js';
import type { RuntimeMetrics } from '@/observability/metrics.js';
import type { BoardElement } from '@/mutations/types.js';
import type { BoardRuntimeMetrics } from '@/services/board-state/types.js';
import {
    ACTIVE_BOARDS_KEY,
    BOARD_EVICTION_LOCK_TTL_MS,
    DIRTY_BOARDS_BY_AGE_KEY,
    DIRTY_BOARDS_KEY,
    VIEWER_SESSION_TTL_MS,
    boardClientsKey,
    boardDeletedElementIdsKey,
    boardDirtyElementIdsKey,
    boardDirtyEpochKey,
    boardDirtySinceKey,
    boardElementsKey,
    boardEvictionLockKey,
    boardLastFlushDurationKey,
    boardLastFlushedAtKey,
    boardLastFlushedSequenceKey,
    boardSeqKey,
    boardViewerSessionsKey,
    sleep,
} from '@/services/board-state/keys.js';
import { boards, elements } from '@/db/schema.js';

interface PersistenceDomainDeps {
  waitForBoardLoad: (boardId: string) => Promise<void>
  getElements: (boardId: string) => Promise<Record<string, BoardElement>>
  peekSequence: (boardId: string) => Promise<number>
  metrics: RuntimeMetrics
  enableIncrementalPersistence: boolean
}

export interface PersistDirtyBoardsOptions {
  limit?: number
  minDirtyAgeMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}

export interface FlushBoardOptions {
  requireIdle?: boolean
}

export function createBoardPersistenceDomain(redis: Redis, db: Database, deps: PersistenceDomainDeps) {
    const {
        waitForBoardLoad,
        getElements,
        peekSequence,
        metrics,
        enableIncrementalPersistence,
    } = deps;
    const persistLocks = new Map<string, Promise<void>>();
    const UUID_V4_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    async function withPersistLock(boardId: string, task: () => Promise<void>): Promise<void> {
        const previous = persistLocks.get(boardId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });

        persistLocks.set(boardId, previous.then(() => current));

        await previous;

        try {
            await task();
        } finally {
            release();
            if (persistLocks.get(boardId) === current) {
                persistLocks.delete(boardId);
            }
        }
    }

    async function getDirtySince(boardId: string): Promise<number | null> {
        const raw = await redis.get(boardDirtySinceKey(boardId));
        return raw ? parseInt(raw, 10) : null;
    }

    async function getDirtyEpoch(boardId: string): Promise<number> {
        const raw = await redis.get(boardDirtyEpochKey(boardId));
        if (!raw) {
            return 0;
        }

        const parsed = parseInt(raw, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    async function acquireEvictionLock(boardId: string): Promise<string | null> {
        const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const acquired = await redis.set(boardEvictionLockKey(boardId), token, 'PX', BOARD_EVICTION_LOCK_TTL_MS, 'NX');
        return acquired === 'OK' ? token : null;
    }

    async function releaseEvictionLock(boardId: string, token: string): Promise<void> {
        await redis.eval(
            `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        end

        return 0
      `,
            1,
            boardEvictionLockKey(boardId),
            token,
        );
    }

    function toElementRow(boardId: string, element: BoardElement, serverTimestamp: Date) {
        const { id, kind, updatedAt: _updatedAt, ...data } = element;
        return {
            id,
            boardId,
            type: kind,
            data,
            updatedAt: serverTimestamp,
        };
    }

    async function boardExists(boardId: string): Promise<boolean> {
        const rows = await db
            .select({ id: boards.id })
            .from(boards)
            .where(eq(boards.id, boardId));

        return rows.length > 0;
    }

    function isUuidLike(value: string): boolean {
        return UUID_V4_LIKE.test(value);
    }

    function collectErrorChain(error: unknown): unknown[] {
        const chain: unknown[] = [];
        const seen = new Set<unknown>();
        let current: unknown = error;

        while (current && !seen.has(current)) {
            chain.push(current);
            seen.add(current);
            current = (current as { cause?: unknown }).cause;
        }

        return chain;
    }

    function isMissingBoardForeignKeyViolation(error: unknown): boolean {
        const chain = collectErrorChain(error);

        return chain.some((candidate) => {
            const inspected = candidate as {
        code?: string
        constraint_name?: string
        message?: string
        detail?: string
      };

            if (inspected.code !== '23503') {
                return false;
            }

            if (inspected.constraint_name === 'elements_board_id_boards_id_fk') {
                return true;
            }

            const details = `${inspected.message ?? ''} ${inspected.detail ?? ''}`;
            return details.includes('elements_board_id_boards_id_fk')
        || details.includes('is not present in table "boards"');
        });
    }

    function isInvalidUuidError(error: unknown): boolean {
        const chain = collectErrorChain(error);
        return chain.some((candidate) => {
            const inspected = candidate as {
        code?: string
        message?: string
        detail?: string
      };

            if (inspected.code === '22P02') {
                return true;
            }

            const text = `${inspected.message ?? ''} ${inspected.detail ?? ''}`.toLowerCase();
            return text.includes('invalid input syntax for type uuid');
        });
    }

    async function clearInvalidBoardState(boardId: string): Promise<void> {
        await flushBoard(boardId);
        metrics.logStructured('board.flush_skipped_invalid_id', { boardId });
    }

    async function clearMissingBoardState(boardId: string): Promise<void> {
        await flushBoard(boardId);
        metrics.logStructured('board.flush_skipped_missing_parent', { boardId });
    }

    async function boardExistsSafely(boardId: string): Promise<boolean> {
        try {
            return await boardExists(boardId);
        } catch (error) {
            if (isInvalidUuidError(error)) {
                await clearInvalidBoardState(boardId);
                return false;
            }

            throw error;
        }
    }

    async function persistBoardFullSnapshot(boardId: string, serverTimestamp: Date): Promise<number> {
        const currentElements = await getElements(boardId);
        const nextRows = Object.values(currentElements).map((element) => toElementRow(boardId, element, serverTimestamp));

        await db.transaction(async (tx) => {
            await tx.delete(elements).where(eq(elements.boardId, boardId));
            if (nextRows.length > 0) {
                await tx.insert(elements).values(nextRows);
            }
            await tx.update(boards).set({ updatedAt: serverTimestamp }).where(eq(boards.id, boardId));
        });

        return nextRows.length;
    }

    async function persistBoardIncremental(boardId: string, serverTimestamp: Date): Promise<{ upserts: number; deletes: number }> {
        const dirtyElementIdsKey = boardDirtyElementIdsKey(boardId);
        const deletedElementIdsKey = boardDeletedElementIdsKey(boardId);
        const [dirtyIds, deletedIds] = await Promise.all([
            redis.smembers(dirtyElementIdsKey),
            redis.smembers(deletedElementIdsKey),
        ]);
        metrics.incrementCounter('redis.commands', 2, { category: 'state', command: 'smembers' });

        if (dirtyIds.length === 0 && deletedIds.length === 0) {
            return { upserts: 0, deletes: 0 };
        }

        const rawDirtyElements = dirtyIds.length > 0
            ? await redis.hmget(boardElementsKey(boardId), ...dirtyIds)
            : [];
        if (dirtyIds.length > 0) {
            metrics.incrementCounter('redis.commands', 1, { category: 'state', command: 'hmget' });
        }

        const upserts: ReturnType<typeof toElementRow>[] = [];
        const deletes = new Set(deletedIds);

        for (let index = 0; index < dirtyIds.length; index += 1) {
            const id = dirtyIds[index];
            const json = rawDirtyElements[index];
            if (!id) {
                continue;
            }
            if (!json) {
                deletes.add(id);
                continue;
            }

            const element = JSON.parse(json) as BoardElement;
            upserts.push(toElementRow(boardId, element, serverTimestamp));
        }

        await db.transaction(async (tx) => {
            if (deletes.size > 0) {
                await tx
                    .delete(elements)
                    .where(and(eq(elements.boardId, boardId), inArray(elements.id, [...deletes])));
            }

            if (upserts.length > 0) {
                await tx
                    .insert(elements)
                    .values(upserts)
                    .onConflictDoUpdate({
                        target: elements.id,
                        set: {
                            boardId,
                            type: sql`excluded.type`,
                            data: sql`excluded.data`,
                            updatedAt: serverTimestamp,
                        },
                    });
            }

            await tx.update(boards).set({ updatedAt: serverTimestamp }).where(eq(boards.id, boardId));
        });

        return {
            upserts: upserts.length,
            deletes: deletes.size,
        };
    }

    async function persistBoard(boardId: string): Promise<void> {
        await waitForBoardLoad(boardId);
        await withPersistLock(boardId, async () => {
            if (!isUuidLike(boardId)) {
                await clearInvalidBoardState(boardId);
                return;
            }

            if (!(await boardExistsSafely(boardId))) {
                await clearMissingBoardState(boardId);
                return;
            }

            const isLoaded = await redis.exists(boardSeqKey(boardId));
            if (isLoaded !== 1) {
                await redis
                    .pipeline()
                    .srem(DIRTY_BOARDS_KEY, boardId)
                    .zrem(DIRTY_BOARDS_BY_AGE_KEY, boardId)
                    .srem(ACTIVE_BOARDS_KEY, boardId)
                    .exec();
                return;
            }

            const flushStartedAt = Date.now();
            const dirtySince = await getDirtySince(boardId);
            const snapshotSequence = await peekSequence(boardId);
            const snapshotDirtyEpoch = await getDirtyEpoch(boardId);
            const serverTimestamp = new Date();
            let persistedCounts: { upserts: number; deletes: number };
            try {
                persistedCounts = enableIncrementalPersistence
                    ? await persistBoardIncremental(boardId, serverTimestamp)
                    : { upserts: await persistBoardFullSnapshot(boardId, serverTimestamp), deletes: 0 };
            } catch (error) {
                if (isMissingBoardForeignKeyViolation(error)) {
                    await clearMissingBoardState(boardId);
                    return;
                }

                if (isInvalidUuidError(error)) {
                    await clearInvalidBoardState(boardId);
                    return;
                }

                throw error;
            }

            const flushCompletedAt = Date.now();
            const cleared = await redis.eval(
                `
          local currentEpoch = tonumber(redis.call('get', KEYS[1]) or '0')
          local expectedEpoch = tonumber(ARGV[1])
          if currentEpoch ~= expectedEpoch then
            return 0
          end

          redis.call('srem', KEYS[2], ARGV[2])
          redis.call('zrem', KEYS[3], ARGV[2])
          redis.call('del', KEYS[4])
          redis.call('set', KEYS[5], ARGV[3])
          redis.call('set', KEYS[6], ARGV[4])
          redis.call('set', KEYS[7], ARGV[5])

          if ARGV[6] == '1' then
            redis.call('del', KEYS[8])
            redis.call('del', KEYS[9])
          end

          return 1
        `,
                9,
                boardDirtyEpochKey(boardId),
                DIRTY_BOARDS_KEY,
                DIRTY_BOARDS_BY_AGE_KEY,
                boardDirtySinceKey(boardId),
                boardLastFlushedSequenceKey(boardId),
                boardLastFlushedAtKey(boardId),
                boardLastFlushDurationKey(boardId),
                boardDirtyElementIdsKey(boardId),
                boardDeletedElementIdsKey(boardId),
                snapshotDirtyEpoch.toString(),
                boardId,
                snapshotSequence.toString(),
                flushCompletedAt.toString(),
                (flushCompletedAt - flushStartedAt).toString(),
                enableIncrementalPersistence ? '1' : '0',
            );
            metrics.incrementCounter('redis.commands', 1, { category: 'state', command: 'eval' });

            if (Number(cleared) === 1) {
                metrics.observeTiming('flush.duration_ms', flushCompletedAt - flushStartedAt);
                metrics.incrementCounter('flush.rows_persisted', persistedCounts.upserts + persistedCounts.deletes);
                metrics.logStructured('board.flush', {
                    boardId,
                    sequence: snapshotSequence,
                    flushedSequence: snapshotSequence,
                    dirtyAgeMs: Math.max(0, flushStartedAt - (dirtySince ?? flushStartedAt)),
                    durationMs: flushCompletedAt - flushStartedAt,
                    incremental: enableIncrementalPersistence,
                    upserts: persistedCounts.upserts,
                    deletes: persistedCounts.deletes,
                });
            } else {
                const latestSequence = await peekSequence(boardId);
                const latestDirtyEpoch = await getDirtyEpoch(boardId);
                metrics.logStructured('board.flush_skipped_clear', {
                    boardId,
                    snapshotSequence,
                    latestSequence,
                    snapshotDirtyEpoch,
                    latestDirtyEpoch,
                    incremental: enableIncrementalPersistence,
                    upserts: persistedCounts.upserts,
                    deletes: persistedCounts.deletes,
                });
            }
        });
    }

    async function isBoardIdleForFlush(boardId: string): Promise<boolean> {
        const now = Date.now();
        const minActiveTimestamp = now - VIEWER_SESSION_TTL_MS;
        await redis.zremrangebyscore(boardViewerSessionsKey(boardId), 0, minActiveTimestamp);
        const [clientCount, viewerCount] = await Promise.all([
            redis.scard(boardClientsKey(boardId)),
            redis.zcard(boardViewerSessionsKey(boardId)),
        ]);
        return clientCount === 0 && viewerCount === 0;
    }

    async function getBoardMetrics(boardId: string): Promise<BoardRuntimeMetrics> {
        await waitForBoardLoad(boardId);
        const [sequenceRaw, lastFlushedSequenceRaw, dirtySinceRaw, lastFlushedAtRaw, lastFlushDurationRaw] = await Promise.all([
            redis.get(boardSeqKey(boardId)),
            redis.get(boardLastFlushedSequenceKey(boardId)),
            redis.get(boardDirtySinceKey(boardId)),
            redis.get(boardLastFlushedAtKey(boardId)),
            redis.get(boardLastFlushDurationKey(boardId)),
        ]);

        const now = Date.now();
        const dirtySince = dirtySinceRaw ? parseInt(dirtySinceRaw, 10) : null;

        return {
            sequence: sequenceRaw ? parseInt(sequenceRaw, 10) : 0,
            lastFlushedSequence: lastFlushedSequenceRaw ? parseInt(lastFlushedSequenceRaw, 10) : 0,
            dirtySince,
            dirtyAgeMs: dirtySince ? Math.max(0, now - dirtySince) : 0,
            lastFlushDurationMs: lastFlushDurationRaw ? parseInt(lastFlushDurationRaw, 10) : null,
            lastFlushedAt: lastFlushedAtRaw ? parseInt(lastFlushedAtRaw, 10) : null,
        };
    }

    async function persistDirtyBoards(options: number | PersistDirtyBoardsOptions = 25): Promise<string[]> {
        const limit = typeof options === 'number' ? options : (options.limit ?? 25);
        const minDirtyAgeMs = typeof options === 'number' ? 0 : (options.minDirtyAgeMs ?? 0);
        const retryAttempts = typeof options === 'number' ? 1 : Math.max(1, options.retryAttempts ?? 3);
        const retryDelayMs = typeof options === 'number' ? 0 : Math.max(0, options.retryDelayMs ?? 250);
        const now = Date.now();
        const maxScore = minDirtyAgeMs > 0 ? (now - minDirtyAgeMs).toString() : '+inf';
        const boardIds = await redis.zrangebyscore(DIRTY_BOARDS_BY_AGE_KEY, '-inf', maxScore, 'LIMIT', 0, limit);
        metrics.incrementCounter('redis.commands', 1, { category: 'state', command: 'zrangebyscore' });
        const persisted: string[] = [];

        for (const boardId of boardIds) {
            const dirtySince = await getDirtySince(boardId);
            if (typeof dirtySince === 'number' && dirtySince > 0 && (Date.now() - dirtySince) < minDirtyAgeMs) {
                continue;
            }

            let attempt = 0;
            while (attempt < retryAttempts) {
                attempt += 1;
                try {
                    await persistBoard(boardId);
                    persisted.push(boardId);
                    break;
                } catch (error) {
                    if (attempt >= retryAttempts) {
                        console.error(`[BoardPersistence] persist failed for board=${boardId} attempts=${retryAttempts}`, error);
                        break;
                    }

                    if (retryDelayMs > 0) {
                        await sleep(retryDelayMs);
                    }
                }
            }
        }

        return persisted;
    }

    async function flushBoard(boardId: string, options: FlushBoardOptions = {}): Promise<void> {
        const requireIdle = options.requireIdle ?? false;
        const token = await acquireEvictionLock(boardId);
        if (!token) {
            return;
        }

        try {
            if (requireIdle && !(await isBoardIdleForFlush(boardId))) {
                return;
            }

            const pattern = `board:${boardId}:*`;
            const keys: string[] = [];
            let cursor = '0';

            do {
                const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = nextCursor;
                keys.push(...found);
            } while (cursor !== '0');

            if (keys.length > 0) {
                await redis.del(...keys);
            }

            await redis
                .pipeline()
                .srem(DIRTY_BOARDS_KEY, boardId)
                .zrem(DIRTY_BOARDS_BY_AGE_KEY, boardId)
                .srem(ACTIVE_BOARDS_KEY, boardId)
                .exec();
        } finally {
            await releaseEvictionLock(boardId, token);
        }
    }

    return {
        getDirtySince,
        persistBoard,
        getBoardMetrics,
        persistDirtyBoards,
        flushBoard,
    };
}

export type BoardPersistenceDomain = ReturnType<typeof createBoardPersistenceDomain>
