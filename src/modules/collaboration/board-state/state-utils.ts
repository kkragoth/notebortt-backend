import type { BoardElement } from '../mutations/types.js';

export function normalizeUpserts(upserts: BoardElement[]): BoardElement[] {
    const deduped = new Map<string, BoardElement>();

    for (const element of upserts) {
        deduped.set(element.id, element);
    }

    return [...deduped.values()];
}

export function collectCascadeDeleteIds(
    allElements: Record<string, BoardElement>,
    requestedDeletes: string[],
): string[] {
    const pending = [...new Set(requestedDeletes)];
    const deletes = new Set<string>(pending);
    const containedByColumn = new Map<string, string[]>();
    const columnsByMeta = new Map<string, string[]>();

    for (const element of Object.values(allElements)) {
        const containerId = typeof element.containerId === 'string' ? element.containerId : null;
        if (containerId) {
            const siblings = containedByColumn.get(containerId) ?? [];
            siblings.push(element.id);
            containedByColumn.set(containerId, siblings);
        }

        const metaContainerId = typeof element.metaContainerId === 'string' ? element.metaContainerId : null;
        if (metaContainerId) {
            const children = columnsByMeta.get(metaContainerId) ?? [];
            children.push(element.id);
            columnsByMeta.set(metaContainerId, children);
        }
    }

    while (pending.length > 0) {
        const currentId = pending.shift()!;
        const containedChildren = containedByColumn.get(currentId) ?? [];
        const metaChildren = columnsByMeta.get(currentId) ?? [];

        for (const childId of [...containedChildren, ...metaChildren]) {
            if (deletes.has(childId)) {
                continue;
            }

            deletes.add(childId);
            pending.push(childId);
        }
    }

    return [...deletes];
}
