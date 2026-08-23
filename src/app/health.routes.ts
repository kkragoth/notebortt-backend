import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { Database } from '@/platform/db/client.js';
import type Redis from 'ioredis';
import { getOpenSocketIoConnections } from '@/modules/realtime/index.js';
import { DIRTY_BOARDS_BY_AGE_KEY } from '@/modules/collaboration/index.js';

const startTime = Date.now();

const HealthStatus = {
    OK: 'ok',
    ERROR: 'error',
    DEGRADED: 'degraded',
} as const;

type ServiceStatus = typeof HealthStatus.OK | typeof HealthStatus.ERROR
type BoardStateStatus = typeof HealthStatus.OK | typeof HealthStatus.DEGRADED
type BoardStateHealth = {
  dirtyBacklog: number
  lastDirtyAt: number | null
  timeSinceLastDirtyMs: number | null
}

async function checkPostgres(db: Database): Promise<ServiceStatus> {
    try {
        await db.execute(sql`SELECT 1`);
        return HealthStatus.OK;
    } catch {
        return HealthStatus.ERROR;
    }
}

async function checkRedis(redis: Redis): Promise<ServiceStatus> {
    try {
        await redis.ping();
        return HealthStatus.OK;
    } catch {
        return HealthStatus.ERROR;
    }
}

function uptimeSeconds(): number {
    return Math.floor((Date.now() - startTime) / 1000);
}

function isAllHealthy(
    postgresStatus: ServiceStatus,
    redisStatus: ServiceStatus,
    boardStateStatus: BoardStateStatus,
): boolean {
    return postgresStatus === HealthStatus.OK && redisStatus === HealthStatus.OK && boardStateStatus === HealthStatus.OK;
}

async function getBoardStateHealth(redis: Redis): Promise<{
  status: BoardStateStatus
  boardState: BoardStateHealth
}> {
    try {
        const [dirtyBacklog, latestDirtyWithScore] = await Promise.all([
            redis.zcard(DIRTY_BOARDS_BY_AGE_KEY),
            redis.zrevrange(DIRTY_BOARDS_BY_AGE_KEY, 0, 0, 'WITHSCORES'),
        ]);

        if (latestDirtyWithScore.length < 2) {
            return {
                status: HealthStatus.OK,
                boardState: {
                    dirtyBacklog,
                    lastDirtyAt: null,
                    timeSinceLastDirtyMs: null,
                },
            };
        }

        const rawScore = latestDirtyWithScore[1];
        const lastDirtyAt = typeof rawScore === 'string' ? parseInt(rawScore, 10) : NaN;
        const validLastDirtyAt = Number.isFinite(lastDirtyAt) ? lastDirtyAt : null;

        return {
            status: HealthStatus.OK,
            boardState: {
                dirtyBacklog,
                lastDirtyAt: validLastDirtyAt,
                timeSinceLastDirtyMs: validLastDirtyAt === null ? null : Math.max(0, Date.now() - validLastDirtyAt),
            },
        };
    } catch {
        return {
            status: HealthStatus.DEGRADED,
            boardState: {
                dirtyBacklog: 0,
                lastDirtyAt: null,
                timeSinceLastDirtyMs: null,
            },
        };
    }
}

export function healthRoute(db: Database, redis: Redis) {
    return async (_req: Request, res: Response) => {
        const [postgresStatus, redisStatus, boardStateHealth] = await Promise.all([
            checkPostgres(db),
            checkRedis(redis),
            getBoardStateHealth(redis),
        ]);

        const healthy = isAllHealthy(postgresStatus, redisStatus, boardStateHealth.status);
        const status = healthy ? HealthStatus.OK : HealthStatus.DEGRADED;
        const statusCode = healthy ? 200 : 503;

        res.status(statusCode).json({
            status,
            postgres: postgresStatus,
            redis: redisStatus,
            uptime: uptimeSeconds(),
            openWebSocketConnections: getOpenSocketIoConnections(),
            boardState: boardStateHealth.boardState,
        });
    };
}
