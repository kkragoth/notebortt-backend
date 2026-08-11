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

/** True when the element is contained in a managed month-range meta column. */
function isInsideManagedMeta(context: LockContext, element: BoardElement): boolean {
  const record = asRecord(element)
  const metaId = record.metaContainerId
  if (typeof metaId !== 'string') return false
  const meta = context.elementsById.get(metaId)
  return meta !== undefined && asRecord(meta).monthRange !== undefined
}

/** True when the given fields would newly contain the element into a managed
 *  month-range meta (the element is not already inside that meta). */
function patchesIntoManagedMeta(
  context: LockContext,
  element: BoardElement,
  fields: Partial<BoardElement>,
): boolean {
  const target = fields.metaContainerId
  if (typeof target !== 'string') return false
  const meta = context.elementsById.get(target)
  if (!meta || asRecord(meta).monthRange === undefined) return false
  return asRecord(element).metaContainerId !== target
}

/** True when the created element would be placed inside a managed month-range meta. */
function createsIntoManagedMeta(context: LockContext, data: BoardElement): boolean {
  const target = asRecord(data).metaContainerId
  if (typeof target !== 'string') return false
  const meta = context.elementsById.get(target)
  return meta !== undefined && asRecord(meta).monthRange !== undefined
}

/** Position/containment mutations on a locked element — or on an element
 *  contained inside a locked grid/meta layout — are rejected so locks stay
 *  authoritative in collaborative sessions, not just a frontend affordance.
 *  Explicit additions into a locked layout (element currently uncontained) are
 *  allowed, matching the "lock only blocks dragging" product rule.
 *
 *  Managed month-range metas additionally reject any structural change
 *  (drag in/out/reorder) except through the RECONCILE_MONTH_RANGE mutation. */
export function isMutationBlockedByLock(operation: Operation, context: LockContext): boolean {
  switch (operation.type) {
    case MutationType.MOVE_ELEMENTS:
      return operation.moves.some((move) => {
        const element = context.elementsById.get(move.elementId)
        return element !== undefined && (
          isElementLocked(element)
          || isInsideLockedContainer(context, element)
          || isInsideManagedMeta(context, element)
        )
      })

    case MutationType.UPDATE_ELEMENT:
      if (!isPositionPatch(operation.fields)) {
        return false
      }
      {
        const element = context.elementsById.get(operation.elementId)
        if (!element) return false
        return isElementLocked(element)
          || isInsideLockedContainer(context, element)
          || isInsideManagedMeta(context, element)
          || patchesIntoManagedMeta(context, element, operation.fields)
      }

    case MutationType.UPDATE_ELEMENTS:
      return operation.updates.some((update) => {
        if (!isPositionPatch(update.fields)) {
          return false
        }
        const element = context.elementsById.get(update.elementId)
        if (!element) return false
        return isElementLocked(element)
          || isInsideLockedContainer(context, element)
          || isInsideManagedMeta(context, element)
          || patchesIntoManagedMeta(context, element, update.fields)
      })

    case MutationType.CREATE_ELEMENT:
      return createsIntoManagedMeta(context, operation.data)

    case MutationType.DELETE_ELEMENTS: {
      const deletedIds = new Set(operation.elementIds)
      return operation.elementIds.some((elementId) => {
        const element = context.elementsById.get(elementId)
        if (!element) return false
        const record = asRecord(element)
        const metaId = record.metaContainerId
        if (typeof metaId !== 'string') return false
        // Deleting the managed meta itself cascades to its months.
        if (deletedIds.has(metaId)) return false
        const meta = context.elementsById.get(metaId)
        return meta !== undefined && asRecord(meta).monthRange !== undefined
      })
    }

    default:
      return false
  }
}
