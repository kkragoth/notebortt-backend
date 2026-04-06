import { Router } from 'express'
import { sql } from 'drizzle-orm'
import type Redis from 'ioredis'
import type { AppConfig } from '../config.js'
import type { Database } from '../db/client.js'
import { sendBadRequest } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import { debugStateQuerySchema } from '../openapi/schemas.js'

const MAX_REDIS_KEYS = 100
const DEFAULT_BOARD_SCAN_LIMIT = 20

interface DebugRouteDeps {
  config: Pick<AppConfig, 'nodeEnv'>
  db: Database
  redis: Redis
}

async function scanRedisKeys(redis: Redis, pattern: string, limit: number): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const [nextCursor, foundKeys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', Math.min(limit, 100))
    cursor = nextCursor
    keys.push(...foundKeys)
  } while (cursor !== '0' && keys.length < limit)

  return keys.slice(0, limit)
}

async function getRedisInfo(redis: Redis, boardId?: string) {
  const [info, dbSize] = await Promise.all([
    redis.info('memory'),
    redis.dbsize(),
  ])

  const keyPattern = boardId ? `board:${boardId}:*` : 'board:*'
  const keys = await scanRedisKeys(redis, keyPattern, MAX_REDIS_KEYS)

  const boardState = boardId
    ? {
        sequence: await redis.get(`board:${boardId}:seq`),
        clientCount: await redis.scard(`board:${boardId}:clients`),
        elementCount: await redis.hlen(`board:${boardId}:elements`),
        lastActive: await redis.get(`board:${boardId}:last_active`),
      }
    : null

  return {
    dbSize,
    keyPattern,
    sampledKeys: keys,
    boardState,
    memory: info
      .split('\n')
      .filter((line) => line.startsWith('used_memory_human:') || line.startsWith('used_memory_peak_human:') || line.startsWith('mem_fragmentation_ratio:'))
      .map((line) => line.trim()),
  }
}

async function getDatabaseInfo(db: Database, limit: number) {
  const [counts, recentBoards] = await Promise.all([
    db.execute(sql`
      select
        (select count(*)::int from users) as users,
        (select count(*)::int from workspaces) as workspaces,
        (select count(*)::int from boards) as boards,
        (select count(*)::int from elements) as elements,
        (select count(*)::int from mutations) as mutations
    `),
    db.execute(sql`
      select
        id,
        workspace_id as "workspaceId",
        name,
        updated_at as "updatedAt",
        preview_updated_at as "previewUpdatedAt"
      from boards
      order by updated_at desc nulls last
      limit ${limit}
    `),
  ])

  return {
    counts: counts[0] ?? null,
    recentBoards,
  }
}

export function createDebugRouter({ config, db, redis }: DebugRouteDeps) {
  const router = Router()

  router.use((_, res, next) => {
    if (config.nodeEnv === 'production') {
      res.status(404).json({ error: 'Not found' })
      return
    }

    next()
  })

  router.get('/state', async (req, res) => {
    const parsed = parseWithSchema(debugStateQuerySchema, req.query)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const limit = parsed.data.limit ?? DEFAULT_BOARD_SCAN_LIMIT

    const [postgres, redisInfo] = await Promise.all([
      getDatabaseInfo(db, limit),
      getRedisInfo(redis, parsed.data.boardId),
    ])

    res.json({
      nodeEnv: config.nodeEnv,
      postgres,
      redis: redisInfo,
    })
  })

  return router
}
