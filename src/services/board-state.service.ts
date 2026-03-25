import type Redis from 'ioredis'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { elements } from '../db/schema.js'
import type { BoardElement } from '../mutations/types.js'

const SEEN_TTL_SECONDS = 300

function boardSeqKey(boardId: string): string {
  return `board:${boardId}:seq`
}

function boardElementsKey(boardId: string): string {
  return `board:${boardId}:elements`
}

function boardSeenKey(boardId: string, mutationId: string): string {
  return `board:${boardId}:seen:${mutationId}`
}

function boardClientsKey(boardId: string): string {
  return `board:${boardId}:clients`
}

function boardLastActiveKey(boardId: string): string {
  return `board:${boardId}:last_active`
}

function clientMember(userId: string, connectionId: string): string {
  return `${userId}:${connectionId}`
}

function dbRowToBoardElement(row: typeof elements.$inferSelect): BoardElement {
  const data = row.data as Record<string, unknown>
  return {
    id: row.id,
    kind: row.type,
    ...data,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now(),
  } as BoardElement
}

export function createBoardStateService(redis: Redis, db: Database) {
  async function loadBoard(boardId: string): Promise<number> {
    const seqKey = boardSeqKey(boardId)
    const alreadyLoaded = await redis.exists(seqKey)

    if (alreadyLoaded) {
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
  }

  async function getElements(boardId: string): Promise<Record<string, BoardElement>> {
    const raw = await redis.hgetall(boardElementsKey(boardId))
    const result: Record<string, BoardElement> = {}

    for (const [id, json] of Object.entries(raw)) {
      result[id] = JSON.parse(json) as BoardElement
    }

    return result
  }

  async function getElement(boardId: string, elementId: string): Promise<BoardElement | null> {
    const json = await redis.hget(boardElementsKey(boardId), elementId)
    if (json === null) return null
    return JSON.parse(json) as BoardElement
  }

  async function setElement(boardId: string, elementId: string, element: BoardElement): Promise<void> {
    await redis.hset(boardElementsKey(boardId), elementId, JSON.stringify(element))
  }

  async function deleteElement(boardId: string, elementId: string): Promise<void> {
    await redis.hdel(boardElementsKey(boardId), elementId)
  }

  async function getSequence(boardId: string): Promise<number> {
    return redis.incr(boardSeqKey(boardId))
  }

  async function isDuplicate(boardId: string, mutationId: string): Promise<boolean> {
    const exists = await redis.exists(boardSeenKey(boardId, mutationId))
    return exists === 1
  }

  async function markSeen(boardId: string, mutationId: string): Promise<void> {
    await redis.setex(boardSeenKey(boardId, mutationId), SEEN_TTL_SECONDS, '1')
  }

  async function trackClient(boardId: string, userId: string, connectionId: string): Promise<void> {
    await redis.sadd(boardClientsKey(boardId), clientMember(userId, connectionId))
  }

  async function removeClient(boardId: string, userId: string, connectionId: string): Promise<void> {
    await redis.srem(boardClientsKey(boardId), clientMember(userId, connectionId))
  }

  async function getClientCount(boardId: string): Promise<number> {
    return redis.scard(boardClientsKey(boardId))
  }

  async function touchLastActive(boardId: string): Promise<void> {
    await redis.set(boardLastActiveKey(boardId), Date.now().toString())
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
  }

  return {
    loadBoard,
    getElements,
    getElement,
    setElement,
    deleteElement,
    getSequence,
    isDuplicate,
    markSeen,
    trackClient,
    removeClient,
    getClientCount,
    touchLastActive,
    flushBoard,
  }
}

export type BoardStateService = ReturnType<typeof createBoardStateService>
