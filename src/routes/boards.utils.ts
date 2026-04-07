import { randomUUID } from 'node:crypto'
import { MutationType, type BoardElement, type Mutation } from '../mutations/types.js'

function collectCascadeDeleteIds(
  allElements: Record<string, BoardElement>,
  requestedDeletes: string[],
): string[] {
  const pending = [...new Set(requestedDeletes)]
  const deletes = new Set<string>(pending)
  const containedByColumn = new Map<string, string[]>()
  const columnsByMeta = new Map<string, string[]>()

  for (const element of Object.values(allElements)) {
    const containerId = typeof element.containerId === 'string' ? element.containerId : null
    if (containerId) {
      const siblings = containedByColumn.get(containerId) ?? []
      siblings.push(element.id)
      containedByColumn.set(containerId, siblings)
    }

    const metaContainerId = typeof element.metaContainerId === 'string' ? element.metaContainerId : null
    if (metaContainerId) {
      const children = columnsByMeta.get(metaContainerId) ?? []
      children.push(element.id)
      columnsByMeta.set(metaContainerId, children)
    }
  }

  while (pending.length > 0) {
    const currentId = pending.shift()!
    const containedChildren = containedByColumn.get(currentId) ?? []
    const metaChildren = columnsByMeta.get(currentId) ?? []

    for (const childId of [...containedChildren, ...metaChildren]) {
      if (deletes.has(childId)) {
        continue
      }

      deletes.add(childId)
      pending.push(childId)
    }
  }

  return [...deletes].sort()
}

export function buildElementMutationBatch(
  boardId: string,
  currentElements: Record<string, BoardElement>,
  upserts: unknown[],
  deletes: unknown[],
): Mutation[] {
  const requestedDeletes = deletes as string[]
  const deleteIds = collectCascadeDeleteIds(currentElements, requestedDeletes)
  const deletedIdSet = new Set(deleteIds)
  const clientTimestamp = Date.now()
  const mutations: Mutation[] = []

  if (deleteIds.length > 0) {
    mutations.push({
      mutationId: randomUUID(),
      boardId,
      clientTimestamp,
      operation: {
        type: MutationType.DELETE_ELEMENTS,
        elementIds: deleteIds,
      },
    })
  }

  for (const element of upserts) {
    const boardElement = element as BoardElement
    if (deletedIdSet.has(boardElement.id)) {
      continue
    }

    mutations.push({
      mutationId: randomUUID(),
      boardId,
      clientTimestamp,
      operation: {
        type: MutationType.CREATE_ELEMENT,
        elementId: boardElement.id,
        data: boardElement,
      },
    })
  }

  return mutations
}
