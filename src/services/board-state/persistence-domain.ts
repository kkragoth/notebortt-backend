import { and, eq, inArray, sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import type { Database } from '../../db/client.js'
import { boards, elements } from '../../db/schema.js'
import type { RuntimeMetrics } from '../../observability/metrics.js'
import type { BoardElement } from '../../mutations/types.js'
import {
  ACTIVE_BOARDS_KEY,
  DIRTY_BOARDS_KEY,
  boardDeletedElementIdsKey,
  boardDirtyElementIdsKey,
  boardDirtySinceKey,
  boardElementsKey,
  boardLastFlushDurationKey,
  boardLastFlushedAtKey,
  boardLastFlushedSequenceKey,
  boardSeqKey,
  sleep,
} from './keys.js'
import type { BoardRuntimeMetrics } from './types.js'

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

export function createBoardPersistenceDomain(redis: Redis, db: Database, deps: PersistenceDomainDeps) {
  const { waitForBoardLoad, getElements, peekSequence, metrics, enableIncrementalPersistence } = deps
  const persistLocks = new Map<string, Promise<void>>()

  async function withPersistLock(boardId: string, task: () => Promise<void>): Promise<void> {
    const previous = persistLocks.get(boardId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })

    persistLocks.set(boardId, previous.then(() => current))

    await previous

    try {
      await task()
    } finally {
      release()
      if (persistLocks.get(boardId) === current) {
        persistLocks.delete(boardId)
      }
    }
  }

  async function getDirtySince(boardId: string): Promise<number | null> {
    const raw = await redis.get(boardDirtySinceKey(boardId))
    return raw ? parseInt(raw, 10) : null
  }

  function toElementRow(boardId: string, element: BoardElement, serverTimestamp: Date) {
    const { id, kind, updatedAt: _updatedAt, ...data } = element
    return {
      id,
      boardId,
      type: kind,
      data,
      updatedAt: serverTimestamp,
    }
  }

  async function persistBoardFullSnapshot(boardId: string, serverTimestamp: Date): Promise<number> {
    const currentElements = await getElements(boardId)
    const nextRows = Object.values(currentElements).map((element) => toElementRow(boardId, element, serverTimestamp))

    await db.transaction(async (tx) => {
      await tx.delete(elements).where(eq(elements.boardId, boardId))
      if (nextRows.length > 0) {
        await tx.insert(elements).values(nextRows)
      }
      await tx.update(boards).set({ updatedAt: serverTimestamp }).where(eq(boards.id, boardId))
    })

    return nextRows.length
  }

  async function persistBoardIncremental(boardId: string, serverTimestamp: Date): Promise<{ upserts: number; deletes: number }> {
    const dirtyElementIdsKey = boardDirtyElementIdsKey(boardId)
    const deletedElementIdsKey = boardDeletedElementIdsKey(boardId)
    const [dirtyIds, deletedIds] = await Promise.all([
      redis.smembers(dirtyElementIdsKey),
      redis.smembers(deletedElementIdsKey),
    ])
    metrics.incrementCounter('redis.commands', 2, { category: 'state', command: 'smembers' })

    if (dirtyIds.length === 0 && deletedIds.length === 0) {
      return { upserts: 0, deletes: 0 }
    }

    const rawDirtyElements = dirtyIds.length > 0
      ? await redis.hmget(boardElementsKey(boardId), ...dirtyIds)
      : []
    if (dirtyIds.length > 0) {
      metrics.incrementCounter('redis.commands', 1, { category: 'state', command: 'hmget' })
    }

    const upserts: ReturnType<typeof toElementRow>[] = []
    const deletes = new Set(deletedIds)

    for (let index = 0; index < dirtyIds.length; index += 1) {
      const id = dirtyIds[index]
      const json = rawDirtyElements[index]
      if (!id) {
        continue
      }
      if (!json) {
        deletes.add(id)
        continue
      }

      const element = JSON.parse(json) as BoardElement
      upserts.push(toElementRow(boardId, element, serverTimestamp))
    }

    await db.transaction(async (tx) => {
      if (deletes.size > 0) {
        await tx
          .delete(elements)
          .where(and(eq(elements.boardId, boardId), inArray(elements.id, [...deletes])))
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
          })
      }

      await tx.update(boards).set({ updatedAt: serverTimestamp }).where(eq(boards.id, boardId))
    })

    return {
      upserts: upserts.length,
      deletes: deletes.size,
    }
  }

  async function persistBoard(boardId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    await withPersistLock(boardId, async () => {
      const isLoaded = await redis.exists(boardSeqKey(boardId))
      if (isLoaded !== 1) {
        await redis
          .pipeline()
          .srem(DIRTY_BOARDS_KEY, boardId)
          .srem(ACTIVE_BOARDS_KEY, boardId)
          .exec()
        return
      }

      const flushStartedAt = Date.now()
      const dirtySince = await getDirtySince(boardId)
      const snapshotSequence = await peekSequence(boardId)
      const serverTimestamp = new Date()
      const persistedCounts = enableIncrementalPersistence
        ? await persistBoardIncremental(boardId, serverTimestamp)
        : { upserts: await persistBoardFullSnapshot(boardId, serverTimestamp), deletes: 0 }

      const latestSequence = await peekSequence(boardId)
      if (latestSequence <= snapshotSequence) {
        const flushCompletedAt = Date.now()
        const pipeline = redis.pipeline()
        pipeline.srem(DIRTY_BOARDS_KEY, boardId)
        pipeline.del(boardDirtySinceKey(boardId))
        pipeline.set(boardLastFlushedSequenceKey(boardId), snapshotSequence.toString())
        pipeline.set(boardLastFlushedAtKey(boardId), flushCompletedAt.toString())
        pipeline.set(boardLastFlushDurationKey(boardId), (flushCompletedAt - flushStartedAt).toString())
        if (enableIncrementalPersistence) {
          pipeline.del(boardDirtyElementIdsKey(boardId))
          pipeline.del(boardDeletedElementIdsKey(boardId))
        }
        await pipeline.exec()
        metrics.incrementCounter('redis.commands', 1, { category: 'state', command: 'pipeline.exec' })
        metrics.observeTiming('flush.duration_ms', flushCompletedAt - flushStartedAt)
        metrics.incrementCounter('flush.rows_persisted', persistedCounts.upserts + persistedCounts.deletes)
        metrics.logStructured('board.flush', {
          boardId,
          sequence: snapshotSequence,
          flushedSequence: snapshotSequence,
          dirtyAgeMs: Math.max(0, flushStartedAt - (dirtySince ?? flushStartedAt)),
          durationMs: flushCompletedAt - flushStartedAt,
          incremental: enableIncrementalPersistence,
          upserts: persistedCounts.upserts,
          deletes: persistedCounts.deletes,
        })
      } else {
        metrics.logStructured('board.flush_skipped_clear', {
          boardId,
          snapshotSequence,
          latestSequence,
          incremental: enableIncrementalPersistence,
          upserts: persistedCounts.upserts,
          deletes: persistedCounts.deletes,
        })
      }
    })
  }

  async function getBoardMetrics(boardId: string): Promise<BoardRuntimeMetrics> {
    await waitForBoardLoad(boardId)
    const [sequenceRaw, lastFlushedSequenceRaw, dirtySinceRaw, lastFlushedAtRaw, lastFlushDurationRaw] = await Promise.all([
      redis.get(boardSeqKey(boardId)),
      redis.get(boardLastFlushedSequenceKey(boardId)),
      redis.get(boardDirtySinceKey(boardId)),
      redis.get(boardLastFlushedAtKey(boardId)),
      redis.get(boardLastFlushDurationKey(boardId)),
    ])

    const now = Date.now()
    const dirtySince = dirtySinceRaw ? parseInt(dirtySinceRaw, 10) : null

    return {
      sequence: sequenceRaw ? parseInt(sequenceRaw, 10) : 0,
      lastFlushedSequence: lastFlushedSequenceRaw ? parseInt(lastFlushedSequenceRaw, 10) : 0,
      dirtySince,
      dirtyAgeMs: dirtySince ? Math.max(0, now - dirtySince) : 0,
      lastFlushDurationMs: lastFlushDurationRaw ? parseInt(lastFlushDurationRaw, 10) : null,
      lastFlushedAt: lastFlushedAtRaw ? parseInt(lastFlushedAtRaw, 10) : null,
    }
  }

  async function persistDirtyBoards(options: number | PersistDirtyBoardsOptions = 25): Promise<string[]> {
    const limit = typeof options === 'number' ? options : (options.limit ?? 25)
    const minDirtyAgeMs = typeof options === 'number' ? 0 : (options.minDirtyAgeMs ?? 0)
    const retryAttempts = typeof options === 'number' ? 1 : Math.max(1, options.retryAttempts ?? 3)
    const retryDelayMs = typeof options === 'number' ? 0 : Math.max(0, options.retryDelayMs ?? 250)
    const [boardIds, dirtyBacklog] = await Promise.all([
      redis.srandmember(DIRTY_BOARDS_KEY, limit),
      redis.scard(DIRTY_BOARDS_KEY),
    ])
    metrics.incrementCounter('redis.commands', 2, { category: 'state', command: 'srandmember_or_scard' })
    metrics.logStructured('board.dirty_backlog', { dirtyBoards: dirtyBacklog, sampleSize: boardIds.length })
    const persisted: string[] = []

    for (const boardId of boardIds) {
      const dirtySince = await getDirtySince(boardId)
      if (typeof dirtySince === 'number' && dirtySince > 0 && (Date.now() - dirtySince) < minDirtyAgeMs) {
        continue
      }

      let attempt = 0
      while (attempt < retryAttempts) {
        attempt += 1
        try {
          await persistBoard(boardId)
          persisted.push(boardId)
          break
        } catch (error) {
          if (attempt >= retryAttempts) {
            console.error(`[BoardPersistence] persist failed for board=${boardId} attempts=${retryAttempts}`, error)
            break
          }

          if (retryDelayMs > 0) {
            await sleep(retryDelayMs)
          }
        }
      }
    }

    return persisted
  }

  async function flushBoard(boardId: string): Promise<void> {
    const pattern = `board:${boardId}:*`
    const keys: string[] = []
    let cursor = '0'

    do {
      const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = nextCursor
      keys.push(...found)
    } while (cursor !== '0')

    if (keys.length > 0) {
      await redis.del(...keys)
    }

    await redis
      .pipeline()
      .srem(DIRTY_BOARDS_KEY, boardId)
      .srem(ACTIVE_BOARDS_KEY, boardId)
      .exec()
  }

  return {
    getDirtySince,
    persistBoard,
    getBoardMetrics,
    persistDirtyBoards,
    flushBoard,
  }
}

export type BoardPersistenceDomain = ReturnType<typeof createBoardPersistenceDomain>
