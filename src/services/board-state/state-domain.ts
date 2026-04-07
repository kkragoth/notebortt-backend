import type Redis from 'ioredis'
import type { BoardElement } from '../../mutations/types.js'
import { CHANGE_LOG_MAX_LENGTH, DIRTY_BOARDS_KEY, SEEN_TTL_SECONDS, boardChangeLogKey, boardDirtySinceKey, boardElementsKey, boardLastActiveKey, boardSeenKey, boardSeqKey } from './keys.js'
import { collectCascadeDeleteIds, normalizeUpserts } from './state-utils.js'
import type { ApplyChangeSetOptions, BoardSnapshot, ElementChangeSet, PersistedElementChange } from './types.js'

interface StateDomainDeps {
  waitForBoardLoad: (boardId: string) => Promise<void>
}

export function createBoardStateDomain(redis: Redis, deps: StateDomainDeps) {
  const { waitForBoardLoad } = deps

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

  async function applyChangeSet(
    boardId: string,
    changeSet: ElementChangeSet,
    options: ApplyChangeSetOptions = {},
  ): Promise<PersistedElementChange | null> {
    await waitForBoardLoad(boardId)
    const trackChangeLog = options.trackChangeLog ?? options.trackChanges ?? true
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

    if (trackChangeLog) {
      pipeline.rpush(boardChangeLogKey(boardId), JSON.stringify(persistedChange))
      pipeline.ltrim(boardChangeLogKey(boardId), -CHANGE_LOG_MAX_LENGTH, -1)
    }

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

  return {
    getElements,
    getElement,
    setElement,
    deleteElement,
    getSequence,
    peekSequence,
    isDuplicate,
    tryMarkSeen,
    markSeen,
    applyChangeSet,
    getChangesAfter,
    getSnapshot,
  }
}

export type BoardStateDomain = ReturnType<typeof createBoardStateDomain>
