import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { createDb } from '../src/db/client.js'
import { createRedisClient } from '../src/redis/client.js'
import { createBoardStateService } from '../src/services/board-state.service.js'
import { createMutationProcessor } from '../src/mutations/processor.js'
import { MutationType } from '../src/mutations/types.js'
import type { Mutation } from '../src/mutations/types.js'
import { boards, workspaces, users, elements } from '../src/db/schema.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://notecanva:localdev@localhost:5432/notecanva'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

const db = createDb(DATABASE_URL)
const redis = createRedisClient(REDIS_URL)
const boardStateService = createBoardStateService(redis, db)
const mutationProcessor = createMutationProcessor(boardStateService)

let TEST_BOARD_ID: string
let TEST_USER_ID: string
let TEST_WORKSPACE_ID: string

const TEST_USER_EMAIL = `test-mut-processor-${Date.now()}@test.com`

function makeMutationId(): string {
  return crypto.randomUUID()
}

function makeElementId(): string {
  return crypto.randomUUID()
}

function makeCreateMutation(elementId: string, overrides: Partial<Mutation> = {}): Mutation {
  return {
    mutationId: makeMutationId(),
    boardId: TEST_BOARD_ID,
    clientTimestamp: Date.now(),
    operation: {
      type: MutationType.CREATE_ELEMENT,
      elementId,
      data: {
        id: elementId,
        kind: 'NOTE',
        x: 100,
        y: 200,
        zIndex: 1,
        updatedAt: Date.now(),
      },
    },
    ...overrides,
  }
}

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: TEST_USER_EMAIL, name: 'Test User' })
    .returning()
  TEST_USER_ID = user.id

  const [workspace] = await db
    .insert(workspaces)
    .values({ name: 'Test Workspace', ownerId: TEST_USER_ID })
    .returning()
  TEST_WORKSPACE_ID = workspace.id

  const [board] = await db
    .insert(boards)
    .values({ workspaceId: TEST_WORKSPACE_ID, name: 'Test Board' })
    .returning()
  TEST_BOARD_ID = board.id

  await boardStateService.loadBoard(TEST_BOARD_ID)
})

afterAll(async () => {
  await boardStateService.flushBoard(TEST_BOARD_ID)

  await db.delete(elements).where(eq(elements.boardId, TEST_BOARD_ID))
  await db.delete(boards).where(eq(boards.id, TEST_BOARD_ID))
  await db.delete(workspaces).where(eq(workspaces.id, TEST_WORKSPACE_ID))
  await db.delete(users).where(eq(users.id, TEST_USER_ID))

  await redis.quit()
})

describe('CREATE_ELEMENT', () => {
  it('stores the element in Redis and emits a canonical change', async () => {
    const elementId = makeElementId()
    const mutation = makeCreateMutation(elementId)

    const result = await mutationProcessor.processMutation(mutation, TEST_USER_ID)

    expect(result.status).toBe('applied')
    expect(result.serverTimestamp).toBeTypeOf('number')
    expect(result.sequence).toBeTypeOf('number')

    const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId)
    expect(inRedis).not.toBeNull()
    expect(inRedis?.x).toBe(100)
    expect(inRedis?.y).toBe(200)
    expect(result.change?.upserts).toHaveLength(1)
    expect(result.change?.deletes).toEqual([])
  })
})

describe('Idempotency', () => {
  it('returns already_applied when same mutationId is processed twice', async () => {
    const elementId = makeElementId()
    const mutation = makeCreateMutation(elementId)

    const first = await mutationProcessor.processMutation(mutation, TEST_USER_ID)
    expect(first.status).toBe('applied')

    const second = await mutationProcessor.processMutation(mutation, TEST_USER_ID)
    expect(second.status).toBe('already_applied')
    expect(second.serverTimestamp).toBeUndefined()
  })
})

describe('MOVE_ELEMENTS', () => {
  it('updates x/y in Redis after move', async () => {
    const elementId = makeElementId()
    const createMutation = makeCreateMutation(elementId)
    await mutationProcessor.processMutation(createMutation, TEST_USER_ID)

    const moveMutation: Mutation = {
      mutationId: makeMutationId(),
      boardId: TEST_BOARD_ID,
      clientTimestamp: Date.now(),
      operation: {
        type: MutationType.MOVE_ELEMENTS,
        moves: [{ elementId, x: 500, y: 600 }],
      },
    }

    const result = await mutationProcessor.processMutation(moveMutation, TEST_USER_ID)
    expect(result.status).toBe('applied')

    const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId)
    expect(inRedis?.x).toBe(500)
    expect(inRedis?.y).toBe(600)
  })
})

describe('DELETE_ELEMENTS', () => {
  it('removes the element from Redis after delete', async () => {
    const elementId = makeElementId()
    const createMutation = makeCreateMutation(elementId)
    await mutationProcessor.processMutation(createMutation, TEST_USER_ID)

    const inRedisBefore = await boardStateService.getElement(TEST_BOARD_ID, elementId)
    expect(inRedisBefore).not.toBeNull()

    const deleteMutation: Mutation = {
      mutationId: makeMutationId(),
      boardId: TEST_BOARD_ID,
      clientTimestamp: Date.now(),
      operation: {
        type: MutationType.DELETE_ELEMENTS,
        elementIds: [elementId],
      },
    }

    const result = await mutationProcessor.processMutation(deleteMutation, TEST_USER_ID)
    expect(result.status).toBe('applied')

    const inRedisAfter = await boardStateService.getElement(TEST_BOARD_ID, elementId)
    expect(inRedisAfter).toBeNull()
  })
})

describe('UPDATE_ELEMENT on non-existent element', () => {
  it('does not throw and returns applied', async () => {
    const nonExistentId = makeElementId()
    const updateMutation: Mutation = {
      mutationId: makeMutationId(),
      boardId: TEST_BOARD_ID,
      clientTimestamp: Date.now(),
      operation: {
        type: MutationType.UPDATE_ELEMENT,
        elementId: nonExistentId,
        fields: { x: 999 },
      },
    }

    await expect(mutationProcessor.processMutation(updateMutation, TEST_USER_ID)).resolves.toMatchObject({
      status: 'applied',
    })
  })
})

describe('processBatch', () => {
  it('processes all mutations in order with incrementing sequences', async () => {
    const idA = makeElementId()
    const idB = makeElementId()
    const idC = makeElementId()

    const batch: Mutation[] = [
      makeCreateMutation(idA),
      makeCreateMutation(idB),
      makeCreateMutation(idC),
    ]

    const results = await mutationProcessor.processBatch(batch, TEST_USER_ID)

    expect(results).toHaveLength(3)
    expect(results.every((r) => r.status === 'applied')).toBe(true)

    const sequences = results.map((r) => r.sequence as number)
    expect(sequences[1]).toBe(sequences[0]! + 1)
    expect(sequences[2]).toBe(sequences[1]! + 1)

    for (const id of [idA, idB, idC]) {
      const inRedis = await boardStateService.getElement(TEST_BOARD_ID, id)
      expect(inRedis).not.toBeNull()
    }
  })
})
