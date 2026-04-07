import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { createRedisClient } from '../src/redis/client.js'
import { createBoardStateService } from '../src/services/board-state.service.js'
import type { BoardElement } from '../src/mutations/types.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const redis = createRedisClient(REDIS_URL)
const mockDb = {
  select: () => mockDb,
  from: () => mockDb,
  where: async () => [] as any[],
} as any

const service = createBoardStateService(redis, mockDb)

const TEST_BOARD_ID = `test-board-${Date.now()}`

afterEach(async () => {
  await service.flushBoard(TEST_BOARD_ID)
})

afterAll(async () => {
  await redis.quit()
})

const makeElement = (id: string, overrides: Partial<BoardElement> = {}): BoardElement => ({
  id,
  kind: 'NOTE',
  x: 100,
  y: 200,
  zIndex: 1,
  updatedAt: Date.now(),
  ...overrides,
})

describe('loadBoard', () => {
  it('loads an empty board and initialises seq to 0', async () => {
    const count = await service.loadBoard(TEST_BOARD_ID)
    expect(count).toBe(0)

    const seq = await redis.get(`board:${TEST_BOARD_ID}:seq`)
    expect(seq).toBe('0')
  })

  it('is idempotent — second call returns 0 and does not reset seq', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    await service.getSequence(TEST_BOARD_ID) // bumps seq to 1

    const count = await service.loadBoard(TEST_BOARD_ID)
    expect(count).toBe(0)

    const seq = await redis.get(`board:${TEST_BOARD_ID}:seq`)
    expect(seq).toBe('1')
  })
})

describe('setElement / getElement', () => {
  it('roundtrips a single element', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const element = makeElement('el-1', { x: 42, y: 84 })

    await service.setElement(TEST_BOARD_ID, 'el-1', element)
    const fetched = await service.getElement(TEST_BOARD_ID, 'el-1')

    expect(fetched).toEqual(element)
  })

  it('returns null for a missing element', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const result = await service.getElement(TEST_BOARD_ID, 'does-not-exist')
    expect(result).toBeNull()
  })
})

describe('getElements', () => {
  it('returns all stored elements', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const a = makeElement('el-a')
    const b = makeElement('el-b', { kind: 'TEXT' })

    await service.setElement(TEST_BOARD_ID, 'el-a', a)
    await service.setElement(TEST_BOARD_ID, 'el-b', b)

    const all = await service.getElements(TEST_BOARD_ID)

    expect(Object.keys(all)).toHaveLength(2)
    expect(all['el-a']).toEqual(a)
    expect(all['el-b']).toEqual(b)
  })

  it('returns empty object when board has no elements', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const all = await service.getElements(TEST_BOARD_ID)
    expect(all).toEqual({})
  })
})

describe('deleteElement', () => {
  it('removes the element from the hash', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const element = makeElement('el-del')
    await service.setElement(TEST_BOARD_ID, 'el-del', element)

    await service.deleteElement(TEST_BOARD_ID, 'el-del')

    const result = await service.getElement(TEST_BOARD_ID, 'el-del')
    expect(result).toBeNull()
  })
})

describe('applyChangeSet', () => {
  it('records canonical changes and supports catch-up replay', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const first = makeElement('el-1')
    const second = makeElement('el-2', { x: 500 })

    const applied = await service.applyChangeSet(TEST_BOARD_ID, {
      upserts: [first, second],
      deletes: [],
    })

    expect(applied?.sequence).toBe(1)
    expect(applied?.upserts).toHaveLength(2)

    const catchUp = await service.getChangesAfter(TEST_BOARD_ID, 0)
    expect(catchUp.complete).toBe(true)
    expect(catchUp.changes).toHaveLength(1)
    expect(catchUp.changes[0]?.upserts.map((element) => element.id).sort()).toEqual(['el-1', 'el-2'])
  })

  it('cascades deletes from meta columns to nested columns and contained notes', async () => {
    await service.loadBoard(TEST_BOARD_ID)

    await service.applyChangeSet(TEST_BOARD_ID, {
      upserts: [
        makeElement('meta-1', { kind: 'META_COLUMN' }),
        makeElement('column-1', { kind: 'COLUMN', metaContainerId: 'meta-1' }),
        makeElement('note-1', { containerId: 'column-1', containerColumnId: 'a', containerOrder: 0 }),
      ],
      deletes: [],
    })

    const applied = await service.applyChangeSet(TEST_BOARD_ID, {
      upserts: [],
      deletes: ['meta-1'],
    })

    expect(applied?.deletes.sort()).toEqual(['column-1', 'meta-1', 'note-1'])
    expect(await service.getElement(TEST_BOARD_ID, 'meta-1')).toBeNull()
    expect(await service.getElement(TEST_BOARD_ID, 'column-1')).toBeNull()
    expect(await service.getElement(TEST_BOARD_ID, 'note-1')).toBeNull()
  })
})

describe('getSequence', () => {
  it('returns incrementing numbers on each call', async () => {
    await service.loadBoard(TEST_BOARD_ID)

    const seq1 = await service.getSequence(TEST_BOARD_ID)
    const seq2 = await service.getSequence(TEST_BOARD_ID)
    const seq3 = await service.getSequence(TEST_BOARD_ID)

    expect(seq1).toBe(1)
    expect(seq2).toBe(2)
    expect(seq3).toBe(3)
  })
})

describe('isDuplicate / markSeen', () => {
  it('returns false before marking and true after', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    const mutationId = 'mut-abc-123'

    const before = await service.isDuplicate(TEST_BOARD_ID, mutationId)
    expect(before).toBe(false)

    await service.markSeen(TEST_BOARD_ID, mutationId)

    const after = await service.isDuplicate(TEST_BOARD_ID, mutationId)
    expect(after).toBe(true)
  })
})

describe('trackClient / removeClient / getClientCount', () => {
  it('counts clients correctly after track and remove', async () => {
    await service.loadBoard(TEST_BOARD_ID)

    await service.trackClient(TEST_BOARD_ID, 'user-1', 'conn-a')
    await service.trackClient(TEST_BOARD_ID, 'user-1', 'conn-b')
    await service.trackClient(TEST_BOARD_ID, 'user-2', 'conn-c')

    expect(await service.getClientCount(TEST_BOARD_ID)).toBe(3)

    await service.removeClient(TEST_BOARD_ID, 'user-1', 'conn-a')
    expect(await service.getClientCount(TEST_BOARD_ID)).toBe(2)

    await service.removeClient(TEST_BOARD_ID, 'user-1', 'conn-b')
    await service.removeClient(TEST_BOARD_ID, 'user-2', 'conn-c')
    expect(await service.getClientCount(TEST_BOARD_ID)).toBe(0)
  })
})

describe('flushBoard', () => {
  it('removes all board keys from Redis', async () => {
    await service.loadBoard(TEST_BOARD_ID)
    await service.setElement(TEST_BOARD_ID, 'el-flush', makeElement('el-flush'))
    await service.markSeen(TEST_BOARD_ID, 'mut-flush')
    await service.trackClient(TEST_BOARD_ID, 'user-1', 'conn-x')
    await service.touchLastActive(TEST_BOARD_ID)

    await service.flushBoard(TEST_BOARD_ID)

    const seq = await redis.exists(`board:${TEST_BOARD_ID}:seq`)
    const elem = await redis.exists(`board:${TEST_BOARD_ID}:elements`)
    expect(seq).toBe(0)
    expect(elem).toBe(0)
  })
})
