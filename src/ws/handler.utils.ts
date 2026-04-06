import { and, asc, eq, gt } from 'drizzle-orm'
import type Redis from 'ioredis'
import type WebSocket from 'ws'
import type { IncomingMessage } from 'http'
import type { Database } from '../db/client.js'
import { mutations as mutationsTable } from '../db/schema.js'
import type { BoardStateService } from '../services/board-state.service.js'
import { serialize, type MutationCatchUp } from './messages.js'
import type { UpgradeContext } from './upgrade.js'

const REDIS_MUTATION_CHANNEL_PREFIX = 'board:'
const REDIS_MUTATION_CHANNEL_SUFFIX = ':mutations'

export interface RateLimitState {
  count: number
  windowStart: number
}

export function boardMutationChannel(boardId: string): string {
  return `${REDIS_MUTATION_CHANNEL_PREFIX}${boardId}${REDIS_MUTATION_CHANNEL_SUFFIX}`
}

export function isRateLimited(state: RateLimitState, limit: number): boolean {
  const now = Date.now()
  const windowElapsed = now - state.windowStart

  if (windowElapsed >= 1000) {
    state.count = 0
    state.windowStart = now
  }

  state.count += 1
  return state.count > limit
}

export function extractWsContext(request: IncomingMessage): UpgradeContext | null {
  return (request as any).__wsContext ?? null
}

export async function queryCatchUpMutations(
  db: Database,
  boardId: string,
  afterSequence: number,
): Promise<MutationCatchUp[]> {
  const rows = await db
    .select()
    .from(mutationsTable)
    .where(and(eq(mutationsTable.boardId, boardId), gt(mutationsTable.sequence, afterSequence)))
    .orderBy(asc(mutationsTable.sequence))

  return rows.map((row) => ({
    mutation: {
      mutationId: row.id,
      boardId: row.boardId,
      clientTimestamp: row.clientTs.getTime(),
      serverTimestamp: row.serverTs ? new Date(row.serverTs).getTime() : undefined,
      sequence: row.sequence,
      operation: row.operationData as any,
    },
    sequence: row.sequence,
    serverTimestamp: row.serverTs ? new Date(row.serverTs).getTime() : Date.now(),
  }))
}

export async function sendSnapshot(
  ws: WebSocket,
  boardId: string,
  boardStateService: BoardStateService,
  pubRedis: Redis,
): Promise<void> {
  const elements = await boardStateService.getElements(boardId)
  const currentSeqRaw = await pubRedis.get(`board:${boardId}:seq`)
  const lastSequence = currentSeqRaw ? parseInt(currentSeqRaw, 10) : 0

  ws.send(serialize({ type: 'SNAPSHOT', elements, lastSequence }))
}

export async function sendInitialState(
  ws: WebSocket,
  boardId: string,
  lastSequence: number,
  db: Database,
  boardStateService: BoardStateService,
  pubRedis: Redis,
): Promise<void> {
  if (lastSequence === 0) {
    await sendSnapshot(ws, boardId, boardStateService, pubRedis)
    return
  }

  const catchUpMutations = await queryCatchUpMutations(db, boardId, lastSequence)
  if (catchUpMutations.length > 0) {
    ws.send(serialize({ type: 'CATCH_UP', mutations: catchUpMutations }))
    return
  }

  await sendSnapshot(ws, boardId, boardStateService, pubRedis)
}

export function extractBoardIdFromChannel(channel: string): string | null {
  if (!channel.startsWith(REDIS_MUTATION_CHANNEL_PREFIX) || !channel.endsWith(REDIS_MUTATION_CHANNEL_SUFFIX)) {
    return null
  }

  return channel.slice(REDIS_MUTATION_CHANNEL_PREFIX.length, channel.length - REDIS_MUTATION_CHANNEL_SUFFIX.length)
}

export function tryParseJson(raw: string): any | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
