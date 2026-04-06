import { eq } from 'drizzle-orm'
import type Redis from 'ioredis'
import type { Database } from '../db/client.js'
import { boards, elements } from '../db/schema.js'
import type { BoardPreviewRenderer } from './board-preview.service.js'

const PREVIEW_JOB_DUE_ZSET = 'preview:jobs:due'
const PREVIEW_LOCK_PREFIX = 'preview:job:lock:'

export const PREVIEW_DEBOUNCE_WINDOW_MS = 90_000
export const PREVIEW_MIN_INTERVAL_MS = 180_000

function parseMs(value: Date | null): number | null {
  if (!value) {
    return null
  }
  return new Date(value).getTime()
}

function lockKey(boardId: string): string {
  return `${PREVIEW_LOCK_PREFIX}${boardId}`
}

export function createPreviewJobService(db: Database, redis: Redis, renderer: BoardPreviewRenderer) {
  let timer: NodeJS.Timeout | null = null

  async function enqueue(boardId: string): Promise<{ boardId: string; dueAt: number }> {
    const dueAt = Date.now() + PREVIEW_DEBOUNCE_WINDOW_MS
    await redis.zadd(PREVIEW_JOB_DUE_ZSET, dueAt, boardId)
    return { boardId, dueAt }
  }

  async function maybeDeferForMinInterval(boardId: string): Promise<{ deferred: true; dueAt: number } | { deferred: false }> {
    const [board] = await db
      .select({
        previewUpdatedAt: boards.previewUpdatedAt,
      })
      .from(boards)
      .where(eq(boards.id, boardId))
      .limit(1)

    if (!board) {
      return { deferred: false }
    }

    const previewUpdatedAt = parseMs(board.previewUpdatedAt)
    if (!previewUpdatedAt) {
      return { deferred: false }
    }

    const elapsed = Date.now() - previewUpdatedAt
    if (elapsed >= PREVIEW_MIN_INTERVAL_MS) {
      return { deferred: false }
    }

    const dueAt = previewUpdatedAt + PREVIEW_MIN_INTERVAL_MS
    await redis.zadd(PREVIEW_JOB_DUE_ZSET, dueAt, boardId)
    return { deferred: true, dueAt }
  }

  async function processBoardPreview(boardId: string): Promise<'updated' | 'skipped' | 'deferred'> {
    const deferred = await maybeDeferForMinInterval(boardId)
    if (deferred.deferred) {
      return 'deferred'
    }

    const boardRows = await db
      .select({
        id: boards.id,
      })
      .from(boards)
      .where(eq(boards.id, boardId))
      .limit(1)

    const board = boardRows[0]
    if (!board) {
      return 'skipped'
    }

    const elementRows = await db
      .select({
        id: elements.id,
        type: elements.type,
        data: elements.data,
      })
      .from(elements)
      .where(eq(elements.boardId, boardId))

    const rendered = renderer.render(elementRows)
    const now = new Date()
    await db
      .update(boards)
      .set({
        previewSvg: rendered.svg,
        previewVersion: rendered.version,
        previewUpdatedAt: now,
      })
      .where(eq(boards.id, boardId))

    return 'updated'
  }

  async function runDueJobs(limit = 10): Promise<{ processed: number; deferred: number; skipped: number }> {
    const now = Date.now()
    const boardIds = await redis.zrangebyscore(PREVIEW_JOB_DUE_ZSET, 0, now, 'LIMIT', 0, limit)
    if (boardIds.length === 0) {
      return { processed: 0, deferred: 0, skipped: 0 }
    }

    let processed = 0
    let deferred = 0
    let skipped = 0

    for (const boardId of boardIds) {
      const acquired = await redis.set(lockKey(boardId), '1', 'PX', 60_000, 'NX')
      if (!acquired) {
        continue
      }

      try {
        await redis.zrem(PREVIEW_JOB_DUE_ZSET, boardId)
        const result = await processBoardPreview(boardId)
        if (result === 'updated') {
          processed += 1
        } else if (result === 'deferred') {
          deferred += 1
        } else {
          skipped += 1
        }
      } finally {
        await redis.del(lockKey(boardId))
      }
    }

    return { processed, deferred, skipped }
  }

  function startWorker(intervalMs = 5_000): () => void {
    if (timer) {
      clearInterval(timer)
    }

    timer = setInterval(() => {
      void runDueJobs().catch((error) => {
        console.error('[PreviewJob] runDueJobs failed', error)
      })
    }, intervalMs)

    return () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }

  return {
    enqueue,
    runDueJobs,
    startWorker,
    processBoardPreview,
  }
}

export type PreviewJobService = ReturnType<typeof createPreviewJobService>
