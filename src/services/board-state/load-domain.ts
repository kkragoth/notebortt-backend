import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import type Redis from 'ioredis'
import type { Database } from '../../db/client.js'
import { elements } from '../../db/schema.js'
import type { BoardElement } from '../../mutations/types.js'
import { BOARD_LOAD_LOCK_POLL_MS, BOARD_LOAD_LOCK_TTL_MS, boardElementsKey, boardLoadLockKey, boardSeqKey, sleep } from './keys.js'

function dbRowToBoardElement(row: typeof elements.$inferSelect): BoardElement {
  const data = row.data as Record<string, unknown>
  return {
    id: row.id,
    kind: row.type,
    ...data,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now(),
  } as BoardElement
}

export function createBoardLoadDomain(redis: Redis, db: Database) {
  const loadLocks = new Map<string, Promise<void>>()

  async function withLoadLock<T>(boardId: string, task: () => Promise<T>): Promise<T> {
    const previous = loadLocks.get(boardId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })

    loadLocks.set(boardId, previous.then(() => current))
    await previous

    try {
      return await task()
    } finally {
      release()
      if (loadLocks.get(boardId) === current) {
        loadLocks.delete(boardId)
      }
    }
  }

  async function waitForBoardLoad(boardId: string): Promise<void> {
    const seqKey = boardSeqKey(boardId)
    const lockKey = boardLoadLockKey(boardId)

    while (true) {
      const [lockExists, seqExists] = await Promise.all([
        redis.exists(lockKey),
        redis.exists(seqKey),
      ])

      if (seqExists === 1 || lockExists === 0) {
        return
      }

      await sleep(BOARD_LOAD_LOCK_POLL_MS)
    }
  }

  async function acquireBoardLoadLock(boardId: string): Promise<string | null> {
    const token = randomUUID()
    const acquired = await redis.set(
      boardLoadLockKey(boardId),
      token,
      'PX',
      BOARD_LOAD_LOCK_TTL_MS,
      'NX',
    )

    return acquired === 'OK' ? token : null
  }

  async function releaseBoardLoadLock(boardId: string, token: string): Promise<void> {
    await redis.eval(
      `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        end

        return 0
      `,
      1,
      boardLoadLockKey(boardId),
      token,
    )
  }

  async function loadBoard(boardId: string): Promise<number> {
    return withLoadLock(boardId, async () => {
      const seqKey = boardSeqKey(boardId)
      while (true) {
        const alreadyLoaded = await redis.exists(seqKey)
        if (alreadyLoaded) {
          return 0
        }

        const lockToken = await acquireBoardLoadLock(boardId)
        if (!lockToken) {
          await waitForBoardLoad(boardId)
          continue
        }

        try {
          const loadedAlready = await redis.exists(seqKey)
          if (loadedAlready) {
            return 0
          }

          const rows = await db.select().from(elements).where(eq(elements.boardId, boardId))
          const elementsKey = boardElementsKey(boardId)

          if (rows.length > 0) {
            const pipeline = redis.pipeline()
            for (const row of rows) {
              const element = dbRowToBoardElement(row)
              pipeline.hset(elementsKey, row.id, JSON.stringify(element))
            }
            pipeline.set(seqKey, '0')
            await pipeline.exec()
          } else {
            await redis.set(seqKey, '0')
          }

          return rows.length
        } finally {
          await releaseBoardLoadLock(boardId, lockToken)
        }
      }
    })
  }

  return {
    loadBoard,
    waitForBoardLoad,
  }
}

export type BoardLoadDomain = ReturnType<typeof createBoardLoadDomain>
