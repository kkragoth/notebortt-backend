import { MutationType } from '../mutations/types.js'
import type { Mutation } from '../mutations/types.js'
import {
  TICK_PERSIST_DEBOUNCE_MS,
  TICK_PERSIST_MAX_WAIT_MS,
} from './constants.js'
import type { SocketIoRealtimeDependencies } from './types.js'

interface TickPersistenceOptions {
  onPersistedChange: (boardId: string, userId: string, change: unknown, senderId: string) => Promise<void>
}

export function createTickPersistenceManager(
  deps: SocketIoRealtimeDependencies,
  options: TickPersistenceOptions,
) {
  const pendingTickMovesByBoard = new Map<string, Map<string, { x: number; y: number }>>()
  const tickPersistDebounceTimers = new Map<string, NodeJS.Timeout>()
  const tickPersistMaxWaitTimers = new Map<string, NodeJS.Timeout>()
  const tickPersistUserByBoard = new Map<string, string>()

  async function flushTickMoves(boardId: string): Promise<void> {
    const pendingMoves = pendingTickMovesByBoard.get(boardId)
    if (!pendingMoves || pendingMoves.size === 0) {
      return
    }

    const userId = tickPersistUserByBoard.get(boardId) ?? 'system:tick'
    const moves = Array.from(pendingMoves.entries()).map(([elementId, position]) => ({
      elementId,
      x: position.x,
      y: position.y,
    }))

    pendingMoves.clear()
    const debounceTimer = tickPersistDebounceTimers.get(boardId)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      tickPersistDebounceTimers.delete(boardId)
    }

    const maxWaitTimer = tickPersistMaxWaitTimers.get(boardId)
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer)
      tickPersistMaxWaitTimers.delete(boardId)
    }

    if (moves.length === 0) {
      return
    }

    await deps.boardStateService.loadBoard(boardId)
    const mutation: Mutation = {
      mutationId: `tick:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      boardId,
      clientTimestamp: Date.now(),
      operation: { type: MutationType.MOVE_ELEMENTS, moves },
    }
    const results = await deps.mutationProcessor.processBatch([mutation], userId)
    for (const result of results) {
      if (result.status === 'applied' && result.change) {
        await options.onPersistedChange(boardId, userId, result.change, `tick:${boardId}`)
      }
    }
  }

  function scheduleTickPersist(boardId: string): void {
    const debounceTimer = tickPersistDebounceTimers.get(boardId)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    tickPersistDebounceTimers.set(boardId, setTimeout(() => {
      tickPersistDebounceTimers.delete(boardId)
      void flushTickMoves(boardId)
    }, TICK_PERSIST_DEBOUNCE_MS))

    if (!tickPersistMaxWaitTimers.has(boardId)) {
      tickPersistMaxWaitTimers.set(boardId, setTimeout(() => {
        tickPersistMaxWaitTimers.delete(boardId)
        void flushTickMoves(boardId)
      }, TICK_PERSIST_MAX_WAIT_MS))
    }
  }

  function queueMoves(boardId: string, userId: string, moves: Array<{ id: string; x: number; y: number }>): void {
    if (moves.length === 0) {
      return
    }

    let pendingMoves = pendingTickMovesByBoard.get(boardId)
    if (!pendingMoves) {
      pendingMoves = new Map<string, { x: number; y: number }>()
      pendingTickMovesByBoard.set(boardId, pendingMoves)
    }

    for (const move of moves) {
      pendingMoves.set(move.id, { x: move.x, y: move.y })
    }

    tickPersistUserByBoard.set(boardId, userId)
    scheduleTickPersist(boardId)
  }

  return {
    flushTickMoves,
    queueMoves,
  }
}
