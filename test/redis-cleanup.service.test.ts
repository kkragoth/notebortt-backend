import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createRedisClient } from '../src/redis/client.js'
import { createRedisCleanupService } from '../src/services/redis-cleanup.service.js'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const redis = createRedisClient(REDIS_URL)

const TEST_PREFIX = `test-redis-cleanup-${Date.now()}`

async function deleteKeysByPattern(pattern: string): Promise<void> {
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

afterEach(async () => {
  await deleteKeysByPattern(`board:${TEST_PREFIX}*`)
})

afterAll(async () => {
  await redis.quit()
})

describe('createRedisCleanupService', () => {
  it('flushes inactive boards with no clients or viewers', async () => {
    const boardId = `${TEST_PREFIX}-inactive`
    await redis.set(`board:${boardId}:last_active`, (Date.now() - 20_000).toString())

    const boardStateService = {
      getClientCount: vi.fn().mockResolvedValue(0),
      getActiveViewerCount: vi.fn().mockResolvedValue(0),
      persistBoard: vi.fn().mockResolvedValue(undefined),
      flushBoard: vi.fn().mockResolvedValue(undefined),
    } as any

    const cleanupService = createRedisCleanupService(redis, boardStateService)
    const flushed = await cleanupService.cleanupInactiveBoards(5_000, 10)

    expect(flushed).toContain(boardId)
    expect(boardStateService.persistBoard).toHaveBeenCalledWith(boardId)
    expect(boardStateService.flushBoard).toHaveBeenCalledWith(boardId, { requireIdle: true })
  })

  it('skips inactive boards that still have clients', async () => {
    const boardId = `${TEST_PREFIX}-active-clients`
    await redis.set(`board:${boardId}:last_active`, (Date.now() - 20_000).toString())

    const boardStateService = {
      getClientCount: vi.fn().mockResolvedValue(1),
      getActiveViewerCount: vi.fn().mockResolvedValue(0),
      persistBoard: vi.fn().mockResolvedValue(undefined),
      flushBoard: vi.fn().mockResolvedValue(undefined),
    } as any

    const cleanupService = createRedisCleanupService(redis, boardStateService)
    const flushed = await cleanupService.cleanupInactiveBoards(5_000, 10)

    expect(flushed).toEqual([])
    expect(boardStateService.persistBoard).not.toHaveBeenCalled()
    expect(boardStateService.flushBoard).not.toHaveBeenCalled()
  })

  it('flushes boards that only have stale seq key and no last_active', async () => {
    const boardId = `${TEST_PREFIX}-seq-only`
    await redis.set(`board:${boardId}:seq`, '0')

    const boardStateService = {
      getClientCount: vi.fn().mockResolvedValue(0),
      getActiveViewerCount: vi.fn().mockResolvedValue(0),
      persistBoard: vi.fn().mockResolvedValue(undefined),
      flushBoard: vi.fn().mockResolvedValue(undefined),
    } as any

    const cleanupService = createRedisCleanupService(redis, boardStateService)
    const flushed = await cleanupService.cleanupInactiveBoards(0, 20)

    expect(flushed).toContain(boardId)
    expect(boardStateService.persistBoard).toHaveBeenCalledWith(boardId)
    expect(boardStateService.flushBoard).toHaveBeenCalledWith(boardId, { requireIdle: true })
  })

  it('deletes stale transient keys by idle time', async () => {
    const stalePresenceKey = `account_presences:${TEST_PREFIX}-user-1`
    const staleCursorKey = `remote_cursors:${TEST_PREFIX}-board-1`
    await redis.set(stalePresenceKey, JSON.stringify({ boardId: 'b1' }))
    await redis.hset(staleCursorKey, 'session-a', JSON.stringify({ x: 10, y: 20 }))

    const boardStateService = {
      getClientCount: vi.fn().mockResolvedValue(0),
      getActiveViewerCount: vi.fn().mockResolvedValue(0),
      persistBoard: vi.fn().mockResolvedValue(undefined),
      flushBoard: vi.fn().mockResolvedValue(undefined),
    } as any

    const cleanupService = createRedisCleanupService(redis, boardStateService)
    const deleted = await cleanupService.cleanupTransientDataByIdleTime(0, 100)

    expect(deleted).toContain(stalePresenceKey)
    expect(deleted).toContain(staleCursorKey)
    expect(await redis.exists(stalePresenceKey)).toBe(0)
    expect(await redis.exists(staleCursorKey)).toBe(0)
  })

  it('does not delete board client sets via transient cleanup', async () => {
    const boardId = `${TEST_PREFIX}-clients-safe`
    const clientsKey = `board:${boardId}:clients`
    await redis.sadd(clientsKey, 'user-a:conn-a')

    const boardStateService = {
      getClientCount: vi.fn().mockResolvedValue(0),
      getActiveViewerCount: vi.fn().mockResolvedValue(0),
      persistBoard: vi.fn().mockResolvedValue(undefined),
      flushBoard: vi.fn().mockResolvedValue(undefined),
    } as any

    const cleanupService = createRedisCleanupService(redis, boardStateService)
    const deleted = await cleanupService.cleanupTransientDataByIdleTime(0, 100)

    expect(deleted).not.toContain(clientsKey)
    expect(await redis.exists(clientsKey)).toBe(1)
  })
})
