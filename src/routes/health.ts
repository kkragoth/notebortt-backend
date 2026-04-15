import type { Request, Response } from 'express'
import type { Database } from '../db/client.js'
import type Redis from 'ioredis'
import { sql } from 'drizzle-orm'
import { getOpenSocketIoConnections } from '../socketio/stats.js'
import { DIRTY_BOARDS_BY_AGE_KEY } from '../services/board-state/keys.js'

const startTime = Date.now()

const HealthStatus = {
  OK: 'ok',
  ERROR: 'error',
  DEGRADED: 'degraded',
} as const

type ServiceStatus = typeof HealthStatus.OK | typeof HealthStatus.ERROR

async function checkPostgres(db: Database): Promise<ServiceStatus> {
  try {
    await db.execute(sql`SELECT 1`)
    return HealthStatus.OK
  } catch {
    return HealthStatus.ERROR
  }
}

async function checkRedis(redis: Redis): Promise<ServiceStatus> {
  try {
    await redis.ping()
    return HealthStatus.OK
  } catch {
    return HealthStatus.ERROR
  }
}

function uptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000)
}

function isAllHealthy(postgresStatus: ServiceStatus, redisStatus: ServiceStatus): boolean {
  return postgresStatus === HealthStatus.OK && redisStatus === HealthStatus.OK
}

async function getBoardStateHealth(redis: Redis): Promise<{
  dirtyBacklog: number
  lastDirtyAt: number | null
  timeSinceLastDirtyMs: number | null
}> {
  const [dirtyBacklog, latestDirtyWithScore] = await Promise.all([
    redis.zcard(DIRTY_BOARDS_BY_AGE_KEY),
    redis.zrevrange(DIRTY_BOARDS_BY_AGE_KEY, 0, 0, 'WITHSCORES'),
  ])

  if (latestDirtyWithScore.length < 2) {
    return {
      dirtyBacklog,
      lastDirtyAt: null,
      timeSinceLastDirtyMs: null,
    }
  }

  const rawScore = latestDirtyWithScore[1]
  const lastDirtyAt = typeof rawScore === 'string' ? parseInt(rawScore, 10) : NaN
  const validLastDirtyAt = Number.isFinite(lastDirtyAt) ? lastDirtyAt : null

  return {
    dirtyBacklog,
    lastDirtyAt: validLastDirtyAt,
    timeSinceLastDirtyMs: validLastDirtyAt === null ? null : Math.max(0, Date.now() - validLastDirtyAt),
  }
}

export function healthRoute(db: Database, redis: Redis) {
  return async (_req: Request, res: Response) => {
    const [postgresStatus, redisStatus, boardState] = await Promise.all([
      checkPostgres(db),
      checkRedis(redis),
      getBoardStateHealth(redis),
    ])

    const healthy = isAllHealthy(postgresStatus, redisStatus)
    const status = healthy ? HealthStatus.OK : HealthStatus.DEGRADED
    const statusCode = healthy ? 200 : 503

    res.status(statusCode).json({
      status,
      postgres: postgresStatus,
      redis: redisStatus,
      uptime: uptimeSeconds(),
      openWebSocketConnections: getOpenSocketIoConnections(),
      boardState,
    })
  }
}
