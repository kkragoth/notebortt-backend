import type { BoardStateService } from '../services/board-state.service.js'
import { MutationType } from './types.js'
import type { BoardElement, Mutation, MutationResult, Operation } from './types.js'

interface MutationProcessorOptions {
  enableTargetedReads?: boolean
}

interface CachedBoardContext {
  elementsById: Map<string, BoardElement>
}

export function createMutationProcessor(
  boardStateService: BoardStateService,
  options: MutationProcessorOptions = {},
) {
  const enableTargetedReads = options.enableTargetedReads ?? true
  const boardMutationLocks = new Map<string, Promise<void>>()
  const metrics = boardStateService.metrics

  async function withBoardMutationLock<T>(boardId: string, task: () => Promise<T>): Promise<T> {
    const previous = boardMutationLocks.get(boardId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })

    boardMutationLocks.set(boardId, previous.then(() => current))
    await previous

    try {
      return await task()
    } finally {
      release()
      if (boardMutationLocks.get(boardId) === current) {
        boardMutationLocks.delete(boardId)
      }
    }
  }

  function toUpsertFromCache(
    elementsById: Map<string, BoardElement>,
    elementId: string,
    transform: (existing: BoardElement) => BoardElement,
  ): BoardElement[] {
    const existing = elementsById.get(elementId)
    if (!existing) {
      return []
    }

    return [transform(existing)]
  }

  function toChangeSet(
    context: CachedBoardContext,
    operation: Operation,
  ): { upserts: BoardElement[]; deletes: string[] } {
    if (operation.type === MutationType.CREATE_ELEMENT) {
      return { upserts: [operation.data], deletes: [] }
    }

    if (operation.type === MutationType.UPDATE_ELEMENT) {
      return {
        upserts: toUpsertFromCache(context.elementsById, operation.elementId, (existing) => ({
          ...existing,
          ...operation.fields,
        })),
        deletes: [],
      }
    }

    if (operation.type === MutationType.DELETE_ELEMENTS) {
      return { upserts: [], deletes: operation.elementIds }
    }

    if (operation.type === MutationType.MOVE_ELEMENTS) {
      const upserts = operation.moves.map((move) =>
        toUpsertFromCache(context.elementsById, move.elementId, (existing) => ({
            ...existing,
            x: move.x,
            y: move.y,
          })),
      )

      return {
        upserts: upserts.flat(),
        deletes: [],
      }
    }

    if (operation.type === MutationType.UPDATE_ELEMENTS) {
      const upserts = operation.updates.map((update) =>
        toUpsertFromCache(context.elementsById, update.elementId, (existing) => ({
            ...existing,
            ...update.fields,
          })),
      )

      return {
        upserts: upserts.flat(),
        deletes: [],
      }
    }

    if (operation.type === MutationType.REORDER_ELEMENT) {
      return {
        upserts: toUpsertFromCache(context.elementsById, operation.elementId, (existing) => ({
          ...existing,
          zIndex: operation.zIndex,
        })),
        deletes: [],
      }
    }

    return operation satisfies never
  }

  function collectTouchedElementIds(mutations: Mutation[]): string[] {
    const ids = new Set<string>()
    for (const mutation of mutations) {
      const operation = mutation.operation
      if (operation.type === MutationType.UPDATE_ELEMENT || operation.type === MutationType.REORDER_ELEMENT) {
        ids.add(operation.elementId)
      } else if (operation.type === MutationType.MOVE_ELEMENTS) {
        for (const move of operation.moves) {
          ids.add(move.elementId)
        }
      } else if (operation.type === MutationType.UPDATE_ELEMENTS) {
        for (const update of operation.updates) {
          ids.add(update.elementId)
        }
      }
    }
    return [...ids]
  }

  async function createCachedBoardContext(boardId: string, mutations: Mutation[]): Promise<CachedBoardContext> {
    const touchedElementIds = collectTouchedElementIds(mutations)
    if (touchedElementIds.length === 0) {
      return { elementsById: new Map<string, BoardElement>() }
    }

    if (enableTargetedReads && typeof boardStateService.getElementsByIds === 'function') {
      const existingElements = await boardStateService.getElementsByIds(boardId, touchedElementIds)
      return { elementsById: new Map(existingElements) }
    }

    const pairs = await Promise.all(
      touchedElementIds.map(async (elementId): Promise<[string, BoardElement] | null> => {
        const existing = await boardStateService.getElement(boardId, elementId)
        return existing ? [elementId, existing] : null
      }),
    )

    return {
      elementsById: new Map(
        pairs.filter((entry): entry is [string, BoardElement] => entry !== null),
      ),
    }
  }

  function applyPersistedChangeToContext(context: CachedBoardContext, result: MutationResult): void {
    if (result.status !== 'applied' || !result.change) {
      return
    }
    for (const element of result.change.upserts) {
      context.elementsById.set(element.id, element)
    }
    for (const deletedId of result.change.deletes) {
      context.elementsById.delete(deletedId)
    }
  }

  async function processMutationWithContext(
    mutation: Mutation,
    _userId: string,
    context: CachedBoardContext,
  ): Promise<MutationResult> {
    const { mutationId, boardId, operation } = mutation

    if (operation.type === MutationType.MOVE_ELEMENTS && operation.transient) {
      return { mutationId, status: 'broadcast_only', serverTimestamp: Date.now() }
    }

    const claimed = await boardStateService.tryMarkSeen(boardId, mutationId)
    if (!claimed) {
      return { mutationId, status: 'already_applied' }
    }

    const writeMode = await boardStateService.getSyncWriteMode(boardId)
    const changeSet = toChangeSet(context, operation)
    const persistedChange = await boardStateService.applyChangeSet(boardId, changeSet, {
      trackChangeLog: writeMode === 'collab',
    })

    if (writeMode === 'solo' && persistedChange) {
      await boardStateService.persistBoard(boardId)
    }

    if (!persistedChange) {
      return {
        mutationId,
        status: 'applied',
        serverTimestamp: Date.now(),
        sequence: await boardStateService.peekSequence(boardId),
      }
    }

    return {
      mutationId,
      status: 'applied',
      serverTimestamp: persistedChange.serverTimestamp,
      sequence: persistedChange.sequence,
      change: persistedChange,
    }
  }

  async function processMutation(mutation: Mutation, userId: string): Promise<MutationResult> {
    return withBoardMutationLock(mutation.boardId, async () => {
      const context = await createCachedBoardContext(mutation.boardId, [mutation])
      const result = await processMutationWithContext(mutation, userId, context)
      applyPersistedChangeToContext(context, result)
      return result
    })
  }

  async function processBatch(mutations: Mutation[], userId: string): Promise<MutationResult[]> {
    const startedAt = Date.now()
    const results: MutationResult[] = new Array(mutations.length)
    const byBoard = new Map<string, Array<{ index: number; mutation: Mutation }>>()

    for (let index = 0; index < mutations.length; index += 1) {
      const mutation = mutations[index]
      if (!mutation) {
        continue
      }
      const boardMutations = byBoard.get(mutation.boardId) ?? []
      boardMutations.push({ index, mutation })
      byBoard.set(mutation.boardId, boardMutations)
    }

    for (const [boardId, boardMutations] of byBoard) {
      await withBoardMutationLock(boardId, async () => {
        const context = await createCachedBoardContext(boardId, boardMutations.map((entry) => entry.mutation))
        for (const entry of boardMutations) {
          const result = await processMutationWithContext(entry.mutation, userId, context)
          applyPersistedChangeToContext(context, result)
          results[entry.index] = result
        }
      })
    }

    metrics.observeTiming('mutation.process_batch_ms', Date.now() - startedAt)
    metrics.logStructured('mutation.batch', {
      batchSize: mutations.length,
      boardCount: byBoard.size,
    })

    return results
  }

  return { processMutation, processBatch }
}

export type MutationProcessor = ReturnType<typeof createMutationProcessor>
