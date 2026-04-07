import type { BoardStateService } from '../services/board-state.service.js'
import { MutationType } from './types.js'
import type { BoardElement, Mutation, MutationResult, Operation } from './types.js'

export function createMutationProcessor(boardStateService: BoardStateService) {
  async function toUpsert(
    boardId: string,
    elementId: string,
    transform: (existing: BoardElement) => BoardElement,
  ): Promise<BoardElement[]> {
    const existing = await boardStateService.getElement(boardId, elementId)
    if (!existing) {
      return []
    }

    return [transform(existing)]
  }

  async function toChangeSet(
    boardId: string,
    operation: Operation,
  ): Promise<{ upserts: BoardElement[]; deletes: string[] }> {
    if (operation.type === MutationType.CREATE_ELEMENT) {
      return { upserts: [operation.data], deletes: [] }
    }

    if (operation.type === MutationType.UPDATE_ELEMENT) {
      return {
        upserts: await toUpsert(boardId, operation.elementId, (existing) => ({
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
      const upserts = await Promise.all(
        operation.moves.map((move) =>
          toUpsert(boardId, move.elementId, (existing) => ({
            ...existing,
            x: move.x,
            y: move.y,
          })),
        ),
      )

      return {
        upserts: upserts.flat(),
        deletes: [],
      }
    }

    if (operation.type === MutationType.UPDATE_ELEMENTS) {
      const upserts = await Promise.all(
        operation.updates.map((update) =>
          toUpsert(boardId, update.elementId, (existing) => ({
            ...existing,
            ...update.fields,
          })),
        ),
      )

      return {
        upserts: upserts.flat(),
        deletes: [],
      }
    }

    if (operation.type === MutationType.REORDER_ELEMENT) {
      return {
        upserts: await toUpsert(boardId, operation.elementId, (existing) => ({
          ...existing,
          zIndex: operation.zIndex,
        })),
        deletes: [],
      }
    }

    return operation satisfies never
  }

  async function processMutation(mutation: Mutation, userId: string): Promise<MutationResult> {
    const { mutationId, boardId, operation } = mutation

    if (operation.type === MutationType.MOVE_ELEMENTS && operation.transient) {
      return { mutationId, status: 'broadcast_only', serverTimestamp: Date.now() }
    }

    const isDuplicate = await boardStateService.isDuplicate(boardId, mutationId)
    if (isDuplicate) {
      return { mutationId, status: 'already_applied' }
    }

    await boardStateService.markSeen(boardId, mutationId)
    const changeSet = await toChangeSet(boardId, operation)
    const persistedChange = await boardStateService.applyChangeSet(boardId, changeSet)

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

  async function processBatch(mutations: Mutation[], userId: string): Promise<MutationResult[]> {
    const results: MutationResult[] = []

    for (const mutation of mutations) {
      const result = await processMutation(mutation, userId)
      results.push(result)
    }

    return results
  }

  return { processMutation, processBatch }
}

export type MutationProcessor = ReturnType<typeof createMutationProcessor>
