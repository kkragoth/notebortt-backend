import { sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { mutations } from '../db/schema.js'
import type Redis from 'ioredis'

const LAST_ACTIVE_KEY_PATTERN = 'board:*:last_active'
const ONE_HOUR_MS = 60 * 60 * 1000

function extractBoardIdFromKey(key: string): string | null {
  const match = key.match(/^board:(.+):last_active$/)
  return match ? (match[1] ?? null) : null
}

function isOlderThanOneHour(timestamp: number): boolean {
  return Date.now() - timestamp > ONE_HOUR_MS
}

async function scanLastActiveKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = []
  let cursor = '0'

  do {
    const [nextCursor, found] = await redis.scan(cursor, 'MATCH', LAST_ACTIVE_KEY_PATTERN, 'COUNT', 100)
    cursor = nextCursor
    keys.push(...found)
  } while (cursor !== '0')

  return keys
}

async function deleteStaleBoard(db: Database, boardId: string): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM ${mutations} WHERE board_id = ${boardId}::uuid AND server_ts < now() - interval '1 hour'`,
  )
  return (result as unknown as { rowCount: number }).rowCount ?? 0
}

export function createCompactionService(db: Database, redis: Redis) {
  async function compactStaleMutations(): Promise<number> {
    const keys = await scanLastActiveKeys(redis)
    let totalDeleted = 0

    for (const key of keys) {
      const boardId = extractBoardIdFromKey(key)
      if (!boardId) continue

      const raw = await redis.get(key)
      if (!raw) continue

      const lastActiveTs = parseInt(raw, 10)
      if (!isOlderThanOneHour(lastActiveTs)) continue

      const deleted = await deleteStaleBoard(db, boardId)
      totalDeleted += deleted
    }

    return totalDeleted
  }

  function startCompactionInterval(intervalMs = 10 * 60 * 1000): NodeJS.Timeout {
    const timer = setInterval(async () => {
      try {
        const deleted = await compactStaleMutations()
        if (deleted > 0) console.log(`[Compaction] Deleted ${deleted} stale mutations`)
      } catch (err) {
        console.error('[Compaction] Error:', err)
      }
    }, intervalMs)
    return timer
  }

  return { compactStaleMutations, startCompactionInterval }
}

export type CompactionService = ReturnType<typeof createCompactionService>
