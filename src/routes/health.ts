import type { Request, Response } from 'express'
import type { Database } from '../db/client.js'
import type Redis from 'ioredis'
import { sql } from 'drizzle-orm'
import { getOpenSocketIoConnections } from '../socketio/stats.js'

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

export function healthRoute(db: Database, redis: Redis) {
  return async (_req: Request, res: Response) => {
    const [postgresStatus, redisStatus] = await Promise.all([
      checkPostgres(db),
      checkRedis(redis),
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
    })
  }
}
