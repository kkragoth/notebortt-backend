import { MutationType } from '../mutations/types.js';
import type { BoardElement, Operation } from '../mutations/types.js';

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
]);

export type LockContext = { elementsById: Map<string, BoardElement> }

function asRecord(element: BoardElement): Record<string, unknown> {
    return element;
}

export function isElementLocked(element: BoardElement): boolean {
    return asRecord(element).locked === true;
}

function isInsideLockedContainer(context: LockContext, element: BoardElement): boolean {
    const record = asRecord(element);
    const parentIds = [record.containerId, record.metaContainerId].filter(
        (id): id is string => typeof id === 'string',
    );
    return parentIds.some((parentId) => {
        const parent = context.elementsById.get(parentId);
        return parent !== undefined && isElementLocked(parent);
    });
}

export function isPositionPatch(fields: Partial<BoardElement>): boolean {
    return Object.keys(fields).some((key) => POSITION_FIELDS.has(key));
}

/** True when the element is contained in a managed month-range meta column. */
function isInsideManagedMeta(context: LockContext, element: BoardElement): boolean {
    const record = asRecord(element);
    const metaId = record.metaContainerId;
    if (typeof metaId !== 'string') return false;
    const meta = context.elementsById.get(metaId);
    return meta !== undefined && asRecord(meta).monthRange !== undefined;
}

/** True when the given fields would newly contain the element into a managed
 *  month-range meta (the element is not already inside that meta). */
function patchesIntoManagedMeta(
    context: LockContext,
    element: BoardElement,
    fields: Partial<BoardElement>,
): boolean {
    const target = fields.metaContainerId;
    if (typeof target !== 'string') return false;
    const meta = context.elementsById.get(target);
    if (!meta || asRecord(meta).monthRange === undefined) return false;
    return asRecord(element).metaContainerId !== target;
}

/** True when the created element would be placed inside a managed month-range meta. */
function createsIntoManagedMeta(context: LockContext, data: BoardElement): boolean {
    const target = asRecord(data).metaContainerId;
    if (typeof target !== 'string') return false;
    const meta = context.elementsById.get(target);
    return meta !== undefined && asRecord(meta).monthRange !== undefined;
}

function isManagedMetaRecord(value: unknown): boolean {
    return typeof value === 'object' && value !== null;
}

/** Integrity validation for RECONCILE_MONTH_RANGE. If the meta already exists
 *  it must be a managed month-range (a plain meta can never be hijacked into a
 *  managed range); when it does not exist yet the reconcile is treated as the
 *  first-creation of the managed meta. Upserts must include exactly that meta
 *  (carrying its monthRange) plus elements contained in it; deletes must be
 *  contained months — never the meta itself. Returns an error message, or null
 *  when the operation is self-consistent. */
export function validateReconcileMonthRange(operation: Operation, context: LockContext): string | null {
    if (operation.type !== MutationType.RECONCILE_MONTH_RANGE) return null;

    const meta = context.elementsById.get(operation.metaId);
    if (meta && !isManagedMetaRecord(asRecord(meta).monthRange)) {
        return 'reconcile meta is not a managed month-range';
    }

    const { upserts, deletes } = operation;
    if (upserts.length === 0) return 'reconcile upserts must not be empty';

    const upsertIds = new Set<string>();
    let metaUpsertCount = 0;
    for (const element of upserts) {
        const id = asRecord(element).id;
        if (typeof id !== 'string') return 'reconcile upsert missing id';
        if (upsertIds.has(id)) return 'reconcile upserts contain duplicate ids';
        upsertIds.add(id);

        if (id === operation.metaId) {
            metaUpsertCount += 1;
            if (!isManagedMetaRecord(asRecord(element).monthRange)) {
                return 'reconcile meta upsert is not a managed month-range';
            }
        } else if (asRecord(element).metaContainerId !== operation.metaId) {
            return 'reconcile upsert not contained in meta';
        }
    }
    if (metaUpsertCount !== 1) return 'reconcile upserts must include exactly one managed meta';

    const deleteIds = new Set<string>();
    for (const elementId of deletes) {
        if (elementId === operation.metaId) return 'reconcile may not delete its meta';
        if (deleteIds.has(elementId)) return 'reconcile deletes contain duplicate ids';
        deleteIds.add(elementId);
        if (upsertIds.has(elementId)) return 'reconcile upserts and deletes overlap';

        const element = context.elementsById.get(elementId);
        if (element && asRecord(element).metaContainerId !== operation.metaId) {
            return 'reconcile delete not contained in meta';
        }
    }

    return null;
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
                const element = context.elementsById.get(move.elementId);
                return element !== undefined && (
                    isElementLocked(element)
          || isInsideLockedContainer(context, element)
          || isInsideManagedMeta(context, element)
                );
            });

        case MutationType.UPDATE_ELEMENT:
            if (!isPositionPatch(operation.fields)) {
                return false;
            }
            {
                const element = context.elementsById.get(operation.elementId);
                if (!element) return false;
                return isElementLocked(element)
          || isInsideLockedContainer(context, element)
          || isInsideManagedMeta(context, element)
          || patchesIntoManagedMeta(context, element, operation.fields);
            }

        case MutationType.UPDATE_ELEMENTS:
            return operation.updates.some((update) => {
                if (!isPositionPatch(update.fields)) {
                    return false;
                }
                const element = context.elementsById.get(update.elementId);
                if (!element) return false;
                return isElementLocked(element)
          || isInsideLockedContainer(context, element)
          || isInsideManagedMeta(context, element)
          || patchesIntoManagedMeta(context, element, update.fields);
            });

        case MutationType.CREATE_ELEMENT:
            return createsIntoManagedMeta(context, operation.data);

        case MutationType.DELETE_ELEMENTS: {
            const deletedIds = new Set(operation.elementIds);
            return operation.elementIds.some((elementId) => {
                const element = context.elementsById.get(elementId);
                if (!element) return false;
                const record = asRecord(element);
                const metaId = record.metaContainerId;
                if (typeof metaId !== 'string') return false;
                // Deleting the managed meta itself cascades to its months.
                if (deletedIds.has(metaId)) return false;
                const meta = context.elementsById.get(metaId);
                return meta !== undefined && asRecord(meta).monthRange !== undefined;
            });
        }

        default:
            return false;
    }
}
