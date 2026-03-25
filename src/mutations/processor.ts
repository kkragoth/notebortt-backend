import { eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { elements, mutations } from '../db/schema.js'
import type { BoardStateService } from '../services/board-state.service.js'
import { MutationType } from './types.js'
import type { BoardElement, Mutation, MutationResult, Operation } from './types.js'

export function createMutationProcessor(boardStateService: BoardStateService, db: Database) {
  async function applyToRedis(boardId: string, operation: Operation): Promise<void> {
    if (operation.type === MutationType.CREATE_ELEMENT) {
      await boardStateService.setElement(boardId, operation.elementId, operation.data)
      return
    }

    if (operation.type === MutationType.UPDATE_ELEMENT) {
      const existing = await boardStateService.getElement(boardId, operation.elementId)
      if (!existing) return
      const updated = { ...existing, ...operation.fields }
      await boardStateService.setElement(boardId, operation.elementId, updated)
      return
    }

    if (operation.type === MutationType.DELETE_ELEMENTS) {
      for (const id of operation.elementIds) {
        await boardStateService.deleteElement(boardId, id)
      }
      return
    }

    if (operation.type === MutationType.MOVE_ELEMENTS) {
      for (const move of operation.moves) {
        const existing = await boardStateService.getElement(boardId, move.elementId)
        if (!existing) continue
        const updated: BoardElement = { ...existing, x: move.x, y: move.y, updatedAt: Date.now() }
        await boardStateService.setElement(boardId, move.elementId, updated)
      }
      return
    }

    if (operation.type === MutationType.UPDATE_ELEMENTS) {
      for (const update of operation.updates) {
        const existing = await boardStateService.getElement(boardId, update.elementId)
        if (!existing) continue
        const updated = { ...existing, ...update.fields }
        await boardStateService.setElement(boardId, update.elementId, updated)
      }
      return
    }

    if (operation.type === MutationType.REORDER_ELEMENT) {
      const existing = await boardStateService.getElement(boardId, operation.elementId)
      if (!existing) return
      const updated: BoardElement = { ...existing, zIndex: operation.zIndex, updatedAt: Date.now() }
      await boardStateService.setElement(boardId, operation.elementId, updated)
    }
  }

  async function writeToPostgres(
    boardId: string,
    mutation: Mutation,
    sequence: number,
    serverTimestamp: number,
    userId: string,
  ): Promise<void> {
    const { mutationId, clientTimestamp, operation } = mutation
    const serverTs = new Date(serverTimestamp)
    const clientTs = new Date(clientTimestamp)

    await db.transaction(async (tx) => {
      await tx.insert(mutations).values({
        id: mutationId,
        boardId,
        sequence,
        operationType: operation.type,
        operationData: operation,
        clientTs,
        serverTs,
        userId,
      })

      if (operation.type === MutationType.CREATE_ELEMENT) {
        const { id: _id, kind, ...rest } = operation.data
        await tx.insert(elements).values({
          id: operation.elementId,
          boardId,
          type: kind,
          data: rest,
          updatedAt: serverTs,
        })
        return
      }

      if (operation.type === MutationType.UPDATE_ELEMENT) {
        const existing = await tx
          .select()
          .from(elements)
          .where(eq(elements.id, operation.elementId))
          .limit(1)

        if (existing.length === 0) return

        const mergedData = { ...(existing[0].data as Record<string, unknown>), ...operation.fields }
        await tx
          .update(elements)
          .set({ data: mergedData, updatedAt: serverTs })
          .where(eq(elements.id, operation.elementId))
        return
      }

      if (operation.type === MutationType.DELETE_ELEMENTS) {
        if (operation.elementIds.length === 0) return
        await tx
          .delete(elements)
          .where(
            sql`${elements.id} = ANY(ARRAY[${sql.join(operation.elementIds.map((id) => sql`${id}::uuid`), sql`, `)}]) AND ${elements.boardId} = ${boardId}::uuid`,
          )
        return
      }

      if (operation.type === MutationType.MOVE_ELEMENTS) {
        for (const move of operation.moves) {
          const existing = await tx
            .select()
            .from(elements)
            .where(eq(elements.id, move.elementId))
            .limit(1)

          if (existing.length === 0) continue

          const currentData = (existing[0].data as Record<string, unknown>) ?? {}
          const updatedData = { ...currentData, x: move.x, y: move.y }
          await tx
            .update(elements)
            .set({ data: updatedData, updatedAt: serverTs })
            .where(eq(elements.id, move.elementId))
        }
        return
      }

      if (operation.type === MutationType.UPDATE_ELEMENTS) {
        for (const update of operation.updates) {
          const existing = await tx
            .select()
            .from(elements)
            .where(eq(elements.id, update.elementId))
            .limit(1)

          if (existing.length === 0) continue

          const mergedData = { ...(existing[0].data as Record<string, unknown>), ...update.fields }
          await tx
            .update(elements)
            .set({ data: mergedData, updatedAt: serverTs })
            .where(eq(elements.id, update.elementId))
        }
        return
      }

      if (operation.type === MutationType.REORDER_ELEMENT) {
        const existing = await tx
          .select()
          .from(elements)
          .where(eq(elements.id, operation.elementId))
          .limit(1)

        if (existing.length === 0) return

        const currentData = (existing[0].data as Record<string, unknown>) ?? {}
        const updatedData = { ...currentData, zIndex: operation.zIndex }
        await tx
          .update(elements)
          .set({ data: updatedData, updatedAt: serverTs })
          .where(eq(elements.id, operation.elementId))
      }
    })
  }

  async function processMutation(mutation: Mutation, userId: string): Promise<MutationResult> {
    const { mutationId, boardId, operation } = mutation

    const isDuplicate = await boardStateService.isDuplicate(boardId, mutationId)
    if (isDuplicate) {
      return { mutationId, status: 'already_applied' }
    }

    await boardStateService.markSeen(boardId, mutationId)

    const sequence = await boardStateService.getSequence(boardId)
    const serverTimestamp = Date.now()

    await applyToRedis(boardId, operation)
    await writeToPostgres(boardId, mutation, sequence, serverTimestamp, userId)
    await boardStateService.touchLastActive(boardId)

    return { mutationId, status: 'applied', serverTimestamp, sequence }
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
