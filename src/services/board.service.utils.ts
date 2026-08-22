import { randomUUID } from 'node:crypto';
import type {BoardPermission} from '@/services/board.service.constants.js';
import { elements } from '@/db/schema.js';
import { BOARD_PERMISSION_EDIT, BOARD_PERMISSION_VIEW  } from '@/services/board.service.constants.js';

const REMAPPABLE_ID_KEYS = new Set([
    'id',
    'elementId',
    'parentId',
    'sourceId',
    'targetId',
    'startElementId',
    'endElementId',
    'containerId',
    'containedById',
    'columnId',
    'metaColumnId',
    'gridId',
    'noteId',
    'arrowId',
    'shapeId',
    'textId',
    'drawingId',
    'imageId',
    'linkPreviewId',
    'childId',
    'itemId',
]);

type SourceElementRow = Pick<typeof elements.$inferSelect, 'id' | 'type' | 'data'>

export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}

export function workspaceRoleToBoardPermission(role: string): BoardPermission {
    return role === 'viewer' ? BOARD_PERMISSION_VIEW : BOARD_PERMISSION_EDIT;
}

export function remapElementData(value: unknown, idMap: Map<string, string>, keyHint = ''): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => remapElementData(item, idMap, keyHint));
    }

    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
            result[key] = remapElementData(nestedValue, idMap, key);
        }
        return result;
    }

    if (typeof value === 'string') {
        const remapped = idMap.get(value);
        if (!remapped) {
            return value;
        }

        if (REMAPPABLE_ID_KEYS.has(keyHint) || keyHint.toLowerCase().includes('id')) {
            return remapped;
        }
    }

    return value;
}

export function createElementIdMap(sourceElements: SourceElementRow[]): Map<string, string> {
    const idMap = new Map<string, string>();

    for (const element of sourceElements) {
        idMap.set(element.id, randomUUID());
    }

    return idMap;
}

export function buildDuplicatedElements(
    sourceElements: SourceElementRow[],
    targetBoardId: string,
    now: Date,
) {
    const idMap = createElementIdMap(sourceElements);

    return sourceElements.map((element) => ({
        id: idMap.get(element.id)!,
        boardId: targetBoardId,
        type: element.type,
        data: remapElementData(element.data, idMap) as Record<string, unknown>,
        updatedAt: now,
    }));
}
