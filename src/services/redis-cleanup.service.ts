import type Redis from 'ioredis'
import type { BoardStateService } from './board-state.service.js'

const LAST_ACTIVE_KEY_PATTERN = 'board:*:last_active'
const BOARD_SEQ_KEY_PATTERN = 'board:*:seq'
const DEFAULT_IDLE_TTL_MS = 3 * 60 * 1000
const DEFAULT_SCAN_LIMIT = 50
const DEFAULT_CLEANUP_INTERVAL_MS = 2 * 60 * 1000
const TRANSIENT_KEY_PATTERNS = [
  'board:*:viewer_sessions',
  'presence:*',
  'account_presences:*',
  'remote_cursors:*',
  'cursor:*',
]

function extractBoardIdFromLastActiveKey(key: string): string | null {
  const match = key.match(/^board:(.+):last_active$/)
  return match ? (match[1] ?? null) : null
}

function extractBoardIdFromSeqKey(key: string): string | null {
  const match = key.match(/^board:(.+):seq$/)
  return match ? (match[1] ?? null) : null
}

async function scanLastActiveBoardIds(
  redis: Redis,
  idleTtlMs: number,
  limit: number,
): Promise<string[]> {
  const boardIds: string[] = []
  const idleBefore = Date.now() - idleTtlMs
  let cursor = '0'

  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', LAST_ACTIVE_KEY_PATTERN, 'COUNT', 100)
    cursor = nextCursor

    for (const key of keys) {
      const boardId = extractBoardIdFromLastActiveKey(key)
      if (!boardId) {
        continue
      }

      const rawLastActive = await redis.get(key)
      if (!rawLastActive) {
        continue
      }

      const lastActive = parseInt(rawLastActive, 10)
      if (!Number.isFinite(lastActive) || lastActive > idleBefore) {
        continue
      }

      boardIds.push(boardId)
      if (boardIds.length >= limit) {
        return boardIds
      }
    }
  } while (cursor !== '0')

  return boardIds
}

async function scanKeysByPattern(redis: Redis, pattern: string, limit: number): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = nextCursor
    keys.push(...found)
    if (keys.length >= limit) {
      return keys.slice(0, limit)
    }
  } while (cursor !== '0')

  return keys
}

function toIdleSeconds(idleTtlMs: number): number {
  return Math.max(0, Math.floor(idleTtlMs / 1000))
}

async function isIdleBeyondThreshold(redis: Redis, key: string, idleThresholdSeconds: number): Promise<boolean> {
  const idleTime = await redis.call('OBJECT', 'IDLETIME', key)
  const idleSeconds = typeof idleTime === 'number'
    ? idleTime
    : parseInt(String(idleTime ?? ''), 10)

  return Number.isFinite(idleSeconds) && idleSeconds >= idleThresholdSeconds
}

export function createRedisCleanupService(redis: Redis, boardStateService: BoardStateService) {
  let isWorkerRunning = false

  async function findInactiveBoardCandidates(idleTtlMs: number, limit: number): Promise<string[]> {
    const inactiveByLastActive = await scanLastActiveBoardIds(redis, idleTtlMs, limit)
    const candidates = new Set(inactiveByLastActive)
    const idleThresholdSeconds = toIdleSeconds(idleTtlMs)

    if (candidates.size >= limit) {
      return [...candidates].slice(0, limit)
    }

    const seqKeys = await scanKeysByPattern(redis, BOARD_SEQ_KEY_PATTERN, limit * 2)
    for (const seqKey of seqKeys) {
      const boardId = extractBoardIdFromSeqKey(seqKey)
      if (!boardId || candidates.has(boardId)) {
        continue
      }

      const rawLastActive = await redis.get(`board:${boardId}:last_active`)
      if (rawLastActive) {
        const lastActive = parseInt(rawLastActive, 10)
        if (Number.isFinite(lastActive) && Date.now() - lastActive < idleTtlMs) {
          continue
        }
      } else {
        const seqIdle = await isIdleBeyondThreshold(redis, seqKey, idleThresholdSeconds)
        if (!seqIdle) {
          continue
        }
      }

      candidates.add(boardId)
      if (candidates.size >= limit) {
        break
      }
    }

    return [...candidates]
  }

  async function cleanupInactiveBoards(idleTtlMs = DEFAULT_IDLE_TTL_MS, limit = DEFAULT_SCAN_LIMIT): Promise<string[]> {
    const inactiveBoardIds = await findInactiveBoardCandidates(idleTtlMs, limit)
    const flushedBoardIds: string[] = []

    for (const boardId of inactiveBoardIds) {
      const [clientCount, viewerCount] = await Promise.all([
        boardStateService.getClientCount(boardId),
        boardStateService.getActiveViewerCount(boardId),
      ])

      if (clientCount > 0 || viewerCount > 0) {
        continue
      }

      await boardStateService.persistBoard(boardId)
      await boardStateService.flushBoard(boardId)
      flushedBoardIds.push(boardId)
    }

    return flushedBoardIds
  }

  function startWorker(intervalMs = DEFAULT_CLEANUP_INTERVAL_MS): NodeJS.Timeout {
    return setInterval(async () => {
      if (isWorkerRunning) {
        return
      }

      isWorkerRunning = true
      try {
        const [flushed, transientDeleted] = await Promise.all([
          cleanupInactiveBoards(),
          cleanupTransientDataByIdleTime(),
        ])
        if (flushed.length > 0) {
          console.log(`[RedisCleanup] Flushed ${flushed.length} inactive board(s) from Redis`)
        }
        if (transientDeleted.length > 0) {
          console.log(`[RedisCleanup] Deleted ${transientDeleted.length} stale transient key(s)`)
        }
      } catch (error) {
        console.error('[RedisCleanup] cleanup failed', error)
      } finally {
        isWorkerRunning = false
      }
    }, intervalMs)
  }

  async function cleanupTransientDataByIdleTime(
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    scanLimit = DEFAULT_SCAN_LIMIT,
  ): Promise<string[]> {
    const idleThresholdSeconds = toIdleSeconds(idleTtlMs)
    const deleted: string[] = []

    for (const pattern of TRANSIENT_KEY_PATTERNS) {
      const keys = await scanKeysByPattern(redis, pattern, scanLimit)
      for (const key of keys) {
        const ttl = await redis.ttl(key)
        if (ttl === -2 || ttl > 0) {
          continue
        }

        const isIdle = await isIdleBeyondThreshold(redis, key, idleThresholdSeconds)
        if (!isIdle) {
          continue
        }

        await redis.del(key)
        deleted.push(key)
      }
    }

    return deleted
  }

  return {
    cleanupInactiveBoards,
    cleanupTransientDataByIdleTime,
    startWorker,
  }
}

export type RedisCleanupService = ReturnType<typeof createRedisCleanupService>
