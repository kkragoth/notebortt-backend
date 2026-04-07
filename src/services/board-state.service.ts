import { randomUUID } from 'crypto'
import type Redis from 'ioredis'
import { eq } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boards, elements } from '../db/schema.js'
import type { BoardElement } from '../mutations/types.js'

const SEEN_TTL_SECONDS = 300
const CHANGE_LOG_MAX_LENGTH = 2000
const DIRTY_BOARDS_KEY = 'boards:dirty'
const VIEWER_SESSION_TTL_MS = 90_000
const CLIENT_LEASE_TTL_SECONDS = 90
const BOARD_LOAD_LOCK_TTL_MS = 30_000
const BOARD_LOAD_LOCK_POLL_MS = 25

function boardSeqKey(boardId: string): string {
  return `board:${boardId}:seq`
}

function boardElementsKey(boardId: string): string {
  return `board:${boardId}:elements`
}

function boardSeenKey(boardId: string, mutationId: string): string {
  return `board:${boardId}:seen:${mutationId}`
}

function boardChangeLogKey(boardId: string): string {
  return `board:${boardId}:changes`
}

function boardClientsKey(boardId: string): string {
  return `board:${boardId}:clients`
}

function boardClientLeaseKey(boardId: string, member: string): string {
  return `board:${boardId}:client_lease:${member}`
}

function boardViewerSessionsKey(boardId: string): string {
  return `board:${boardId}:viewer_sessions`
}

function boardLastActiveKey(boardId: string): string {
  return `board:${boardId}:last_active`
}

function boardDirtySinceKey(boardId: string): string {
  return `board:${boardId}:dirty_since`
}

function boardLastFlushedSequenceKey(boardId: string): string {
  return `board:${boardId}:last_flushed_seq`
}

function boardLastFlushedAtKey(boardId: string): string {
  return `board:${boardId}:last_flushed_at`
}

function boardLastFlushDurationKey(boardId: string): string {
  return `board:${boardId}:last_flush_duration_ms`
}

function boardLoadLockKey(boardId: string): string {
  return `board:${boardId}:load_lock`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export interface ElementChangeSet {
  upserts: BoardElement[]
  deletes: string[]
}

export interface PersistedElementChange extends ElementChangeSet {
  sequence: number
  serverTimestamp: number
}

export interface BoardRuntimeMetrics {
  sequence: number
  lastFlushedSequence: number
  dirtySince: number | null
  dirtyAgeMs: number
  lastFlushDurationMs: number | null
  lastFlushedAt: number | null
}

export interface BoardSnapshot {
  elements: Record<string, BoardElement>
  sequence: number
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
  const persistLocks = new Map<string, Promise<void>>()
  const loadLocks = new Map<string, Promise<void>>()

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

  function normalizeUpserts(upserts: BoardElement[]): BoardElement[] {
    const deduped = new Map<string, BoardElement>()

    for (const element of upserts) {
      deduped.set(element.id, element)
    }

    return [...deduped.values()]
  }

  function collectCascadeDeleteIds(
    allElements: Record<string, BoardElement>,
    requestedDeletes: string[],
  ): string[] {
    const pending = [...new Set(requestedDeletes)]
    const deletes = new Set<string>(pending)
    const containedByColumn = new Map<string, string[]>()
    const columnsByMeta = new Map<string, string[]>()

    for (const element of Object.values(allElements)) {
      const containerId = typeof element.containerId === 'string' ? element.containerId : null
      if (containerId) {
        const siblings = containedByColumn.get(containerId) ?? []
        siblings.push(element.id)
        containedByColumn.set(containerId, siblings)
      }

      const metaContainerId = typeof element.metaContainerId === 'string' ? element.metaContainerId : null
      if (metaContainerId) {
        const children = columnsByMeta.get(metaContainerId) ?? []
        children.push(element.id)
        columnsByMeta.set(metaContainerId, children)
      }
    }

    while (pending.length > 0) {
      const currentId = pending.shift()!
      const containedChildren = containedByColumn.get(currentId) ?? []
      const metaChildren = columnsByMeta.get(currentId) ?? []

      for (const childId of [...containedChildren, ...metaChildren]) {
        if (deletes.has(childId)) {
          continue
        }

        deletes.add(childId)
        pending.push(childId)
      }
    }

    return [...deletes]
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

  async function getElements(boardId: string): Promise<Record<string, BoardElement>> {
    await waitForBoardLoad(boardId)
    const raw = await redis.hgetall(boardElementsKey(boardId))
    const result: Record<string, BoardElement> = {}

    for (const [id, json] of Object.entries(raw)) {
      result[id] = JSON.parse(json) as BoardElement
    }

    return result
  }

  async function getElement(boardId: string, elementId: string): Promise<BoardElement | null> {
    await waitForBoardLoad(boardId)
    const json = await redis.hget(boardElementsKey(boardId), elementId)
    if (json === null) return null
    return JSON.parse(json) as BoardElement
  }

  async function setElement(boardId: string, elementId: string, element: BoardElement): Promise<void> {
    await waitForBoardLoad(boardId)
    await redis.hset(boardElementsKey(boardId), elementId, JSON.stringify(element))
  }

  async function deleteElement(boardId: string, elementId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    await redis.hdel(boardElementsKey(boardId), elementId)
  }

  async function getSequence(boardId: string): Promise<number> {
    await waitForBoardLoad(boardId)
    return redis.incr(boardSeqKey(boardId))
  }

  async function peekSequence(boardId: string): Promise<number> {
    await waitForBoardLoad(boardId)
    const raw = await redis.get(boardSeqKey(boardId))
    return raw ? parseInt(raw, 10) : 0
  }

  async function isDuplicate(boardId: string, mutationId: string): Promise<boolean> {
    await waitForBoardLoad(boardId)
    const exists = await redis.exists(boardSeenKey(boardId, mutationId))
    return exists === 1
  }

  async function tryMarkSeen(boardId: string, mutationId: string): Promise<boolean> {
    await waitForBoardLoad(boardId)
    const result = await redis.set(boardSeenKey(boardId, mutationId), '1', 'EX', SEEN_TTL_SECONDS, 'NX')
    return result === 'OK'
  }

  async function markSeen(boardId: string, mutationId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    await redis.setex(boardSeenKey(boardId, mutationId), SEEN_TTL_SECONDS, '1')
  }

  async function trackClient(boardId: string, userId: string, connectionId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    const member = clientMember(userId, connectionId)
    await redis
      .pipeline()
      .sadd(boardClientsKey(boardId), member)
      .set(boardClientLeaseKey(boardId, member), '1', 'EX', CLIENT_LEASE_TTL_SECONDS)
      .exec()
  }

  async function removeClient(boardId: string, userId: string, connectionId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    const member = clientMember(userId, connectionId)
    await redis
      .pipeline()
      .srem(boardClientsKey(boardId), member)
      .del(boardClientLeaseKey(boardId, member))
      .exec()
  }

  async function pruneStaleClients(boardId: string): Promise<void> {
    const members = await redis.smembers(boardClientsKey(boardId))
    if (members.length === 0) {
      return
    }

    const checks = redis.pipeline()
    for (const member of members) {
      checks.exists(boardClientLeaseKey(boardId, member))
    }
    const leaseResults = await checks.exec()
    if (!leaseResults) {
      return
    }

    const staleMembers: string[] = []
    for (let i = 0; i < members.length; i++) {
      const member = members[i]
      if (!member) continue
      const leaseExists = leaseResults[i]?.[1]
      if (leaseExists !== 1) {
        staleMembers.push(member)
      }
    }

    if (staleMembers.length > 0) {
      await redis.srem(boardClientsKey(boardId), ...staleMembers)
    }
  }

  async function getClientCount(boardId: string): Promise<number> {
    await waitForBoardLoad(boardId)
    await pruneStaleClients(boardId)
    return redis.scard(boardClientsKey(boardId))
  }

  async function touchViewerSession(boardId: string, sessionId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    const now = Date.now()
    const minActiveTimestamp = now - VIEWER_SESSION_TTL_MS
    await redis
      .pipeline()
      .zadd(boardViewerSessionsKey(boardId), now, sessionId)
      .zremrangebyscore(boardViewerSessionsKey(boardId), 0, minActiveTimestamp)
      .set(boardLastActiveKey(boardId), now.toString())
      .exec()
  }

  async function removeViewerSession(boardId: string, sessionId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    await redis.zrem(boardViewerSessionsKey(boardId), sessionId)
  }

  async function getActiveViewerCount(boardId: string): Promise<number> {
    await waitForBoardLoad(boardId)
    const now = Date.now()
    const minActiveTimestamp = now - VIEWER_SESSION_TTL_MS
    await redis.zremrangebyscore(boardViewerSessionsKey(boardId), 0, minActiveTimestamp)
    return redis.zcard(boardViewerSessionsKey(boardId))
  }

  async function touchLastActive(boardId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    await redis.set(boardLastActiveKey(boardId), Date.now().toString())
  }

  async function applyChangeSet(boardId: string, changeSet: ElementChangeSet): Promise<PersistedElementChange | null> {
    await waitForBoardLoad(boardId)
    const currentElements = await getElements(boardId)
    const deleteIds = collectCascadeDeleteIds(currentElements, changeSet.deletes)
    const deletedIdSet = new Set(deleteIds)
    const upserts = normalizeUpserts(changeSet.upserts)
      .filter((element) => !deletedIdSet.has(element.id))
      .map((element) => ({ ...element, updatedAt: Date.now() }))

    if (upserts.length === 0 && deleteIds.length === 0) {
      return null
    }

    const sequence = await getSequence(boardId)
    const serverTimestamp = Date.now()
    const persistedChange: PersistedElementChange = {
      sequence,
      serverTimestamp,
      upserts: upserts.map((element) => ({ ...element, updatedAt: serverTimestamp })),
      deletes: deleteIds,
    }

    const pipeline = redis.pipeline()
    const elementsKey = boardElementsKey(boardId)

    for (const element of persistedChange.upserts) {
      pipeline.hset(elementsKey, element.id, JSON.stringify(element))
    }

    if (persistedChange.deletes.length > 0) {
      pipeline.hdel(elementsKey, ...persistedChange.deletes)
    }

    pipeline.rpush(boardChangeLogKey(boardId), JSON.stringify(persistedChange))
    pipeline.ltrim(boardChangeLogKey(boardId), -CHANGE_LOG_MAX_LENGTH, -1)
    pipeline.sadd(DIRTY_BOARDS_KEY, boardId)
    pipeline.setnx(boardDirtySinceKey(boardId), serverTimestamp.toString())
    pipeline.set(boardLastActiveKey(boardId), serverTimestamp.toString())
    await pipeline.exec()

    return persistedChange
  }

  async function getChangesAfter(
    boardId: string,
    afterSequence: number,
  ): Promise<{ changes: PersistedElementChange[]; complete: boolean }> {
    await waitForBoardLoad(boardId)
    const currentSequence = await peekSequence(boardId)
    if (afterSequence >= currentSequence) {
      return { changes: [], complete: true }
    }

    const rawChanges = await redis.lrange(boardChangeLogKey(boardId), 0, -1)
    const changes = rawChanges
      .map((raw) => JSON.parse(raw) as PersistedElementChange)
      .filter((change) => change.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)

    if (changes.length === 0) {
      return { changes: [], complete: false }
    }

    return {
      changes,
      complete: changes[0]?.sequence === afterSequence + 1,
    }
  }

  async function persistBoard(boardId: string): Promise<void> {
    await waitForBoardLoad(boardId)
    await withPersistLock(boardId, async () => {
      const isLoaded = await redis.exists(boardSeqKey(boardId))
      if (isLoaded !== 1) {
        await redis.srem(DIRTY_BOARDS_KEY, boardId)
        return
      }

      const flushStartedAt = Date.now()
      const dirtySince = await getDirtySince(boardId)
      const snapshotSequence = await peekSequence(boardId)
      const currentElements = await getElements(boardId)
      const serverTimestamp = new Date()
      const nextRows = Object.values(currentElements).map((element) => {
        const { id, kind, updatedAt: _updatedAt, ...data } = element
        return {
          id,
          boardId,
          type: kind,
          data,
          updatedAt: serverTimestamp,
        }
      })

      await db.transaction(async (tx) => {
        await tx.delete(elements).where(eq(elements.boardId, boardId))

        if (nextRows.length > 0) {
          await tx.insert(elements).values(nextRows)
        }

        await tx
          .update(boards)
          .set({ updatedAt: serverTimestamp })
          .where(eq(boards.id, boardId))
      })

      const latestSequence = await peekSequence(boardId)
      if (latestSequence <= snapshotSequence) {
        const flushCompletedAt = Date.now()
        await redis
          .pipeline()
          .srem(DIRTY_BOARDS_KEY, boardId)
          .del(boardDirtySinceKey(boardId))
          .set(boardLastFlushedSequenceKey(boardId), snapshotSequence.toString())
          .set(boardLastFlushedAtKey(boardId), flushCompletedAt.toString())
          .set(boardLastFlushDurationKey(boardId), (flushCompletedAt - flushStartedAt).toString())
          .exec()
        console.log(
          `[BoardFlush] board=${boardId} seq=${snapshotSequence} flushedSeq=${snapshotSequence} dirtyAgeMs=${Math.max(0, flushStartedAt - (dirtySince ?? flushStartedAt))} durationMs=${flushCompletedAt - flushStartedAt}`,
        )
      }
    })
  }

  async function getDirtySince(boardId: string): Promise<number | null> {
    const raw = await redis.get(boardDirtySinceKey(boardId))
    return raw ? parseInt(raw, 10) : null
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

  async function getSnapshot(boardId: string): Promise<BoardSnapshot> {
    await waitForBoardLoad(boardId)

    const results = await redis
      .multi()
      .hgetall(boardElementsKey(boardId))
      .get(boardSeqKey(boardId))
      .exec()

    if (!results) {
      return { elements: {}, sequence: 0 }
    }

    const [elementsResult, sequenceResult] = results

    if (elementsResult?.[0]) {
      throw elementsResult[0]
    }

    if (sequenceResult?.[0]) {
      throw sequenceResult[0]
    }

    const rawElements = (elementsResult?.[1] as Record<string, string> | undefined) ?? {}
    const rawSequence = sequenceResult?.[1]
    const elementsSnapshot: Record<string, BoardElement> = {}

    for (const [id, json] of Object.entries(rawElements)) {
      elementsSnapshot[id] = JSON.parse(json) as BoardElement
    }

    return {
      elements: elementsSnapshot,
      sequence: typeof rawSequence === 'string' && rawSequence.length > 0 ? parseInt(rawSequence, 10) : 0,
    }
  }

  async function persistDirtyBoards(limit = 25): Promise<string[]> {
    const boardIds = await redis.srandmember(DIRTY_BOARDS_KEY, limit)
    const persisted: string[] = []

    for (const boardId of boardIds) {
      await persistBoard(boardId)
      persisted.push(boardId)
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

    await redis.srem(DIRTY_BOARDS_KEY, boardId)
  }

  return {
    loadBoard,
    getElements,
    getElement,
    setElement,
    deleteElement,
    getSequence,
    peekSequence,
    isDuplicate,
    tryMarkSeen,
    markSeen,
    trackClient,
    removeClient,
    getClientCount,
    touchViewerSession,
    removeViewerSession,
    getActiveViewerCount,
    touchLastActive,
    applyChangeSet,
    getChangesAfter,
    persistBoard,
    persistDirtyBoards,
    getBoardMetrics,
    getSnapshot,
    flushBoard,
  }
}

export type BoardStateService = ReturnType<typeof createBoardStateService>
