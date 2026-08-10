import { MutationType } from './types.js'
import type { BoardElement, Operation } from './types.js'

const POSITION_FIELDS = new Set([
  'x',
  'y',
  'containerId',
  'containerColumnId',
  'containerOrder',
  'metaContainerId',
  'metaContainerOrder',
  'metaGridCol',
  'metaGridRow',
  'metaGridColSpan',
  'metaGridRowSpan',
])

export type LockContext = { elementsById: Map<string, BoardElement> }

function asRecord(element: BoardElement): Record<string, unknown> {
  return element as Record<string, unknown>
}

export function isElementLocked(element: BoardElement): boolean {
  return asRecord(element).locked === true
}

function isInsideLockedContainer(context: LockContext, element: BoardElement): boolean {
  const record = asRecord(element)
  const parentIds = [record.containerId, record.metaContainerId].filter(
    (id): id is string => typeof id === 'string',
  )
  return parentIds.some((parentId) => {
    const parent = context.elementsById.get(parentId)
    return parent !== undefined && isElementLocked(parent)
  })
}

export function isPositionPatch(fields: Partial<BoardElement>): boolean {
  return Object.keys(fields).some((key) => POSITION_FIELDS.has(key))
}

/** Position/containment mutations on a locked element — or on an element
 *  contained inside a locked grid/meta layout — are rejected so locks stay
 *  authoritative in collaborative sessions, not just a frontend affordance.
 *  Explicit additions into a locked layout (element currently uncontained) are
 *  allowed, matching the "lock only blocks dragging" product rule. */
export function isMutationBlockedByLock(operation: Operation, context: LockContext): boolean {
  switch (operation.type) {
    case MutationType.MOVE_ELEMENTS:
      return operation.moves.some((move) => {
        const element = context.elementsById.get(move.elementId)
        return element !== undefined && (isElementLocked(element) || isInsideLockedContainer(context, element))
      })

    case MutationType.UPDATE_ELEMENT:
      if (!isPositionPatch(operation.fields)) {
        return false
      }
      {
        const element = context.elementsById.get(operation.elementId)
        return element !== undefined && (isElementLocked(element) || isInsideLockedContainer(context, element))
      }

    case MutationType.UPDATE_ELEMENTS:
      return operation.updates.some((update) => {
        if (!isPositionPatch(update.fields)) {
          return false
        }
        const element = context.elementsById.get(update.elementId)
        return element !== undefined && (isElementLocked(element) || isInsideLockedContainer(context, element))
      })

    default:
      return false
  }
}
