import type { Mutation } from '@/modules/collaboration/index.js';

const MAX_MUTATION_BATCH = 100;
const MAX_BOARD_ID_LENGTH = 200;
// Per-field cardinality/length bounds; the event byte caps are the coarse
// limit, these keep individual fields from becoming unbounded Redis members
// or broadcast fields.
const MAX_ID_LENGTH = 200;
const MAX_ID_LIST_LENGTH = 100;
const MAX_MOVES = 500;
const MAX_PRESENCE_MESSAGE_LENGTH = 280;

export interface BoardJoinPayload {
  boardId: string
  lastSequence: number
  sessionId: string
  shareToken?: string
  userName?: string
}

export interface MutationBatchPayload {
  boardId: string
  mutations: Mutation[]
}

export interface CrdtUpdatePayload {
  boardId: string
  update: Uint8Array
}

export interface PresenceUpdatePayload {
  boardId: string
  cursor: { x: number; y: number } | null
  selectedIds: string[]
  draggedIds: string[]
  focusedElementId: string | null
  typingField: 'title' | 'body' | null
}

export interface RealtimeTickPayload {
  boardId: string
  tickId: number
  cursor: { x: number; y: number } | null
  selectedIds: string[]
  draggedIds: string[]
  focusedElementId: string | null
  typingField: 'title' | 'body' | null
  presenceState: 'active' | 'away' | 'interacting'
  presenceMessage: string | null
  moves: Array<{ id: string; x: number; y: number }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeSequence(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '0'), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeUpdate(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
        return value;
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
        return Uint8Array.from(value);
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
        return new Uint8Array(value);
    }

    return null;
}

function isMutationBatch(mutations: unknown): mutations is Mutation[] {
    return Array.isArray(mutations) && mutations.length > 0 && mutations.length <= MAX_MUTATION_BATCH;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseIdList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const ids: string[] = [];
    for (const item of value) {
        if (typeof item === 'string' && item.length > 0 && item.length <= MAX_ID_LENGTH) {
            ids.push(item);
            if (ids.length >= MAX_ID_LIST_LENGTH) {
                break;
            }
        }
    }
    return ids;
}

function parseMoves(value: unknown): Array<{ id: string; x: number; y: number }> {
    if (!Array.isArray(value)) {
        return [];
    }

    const moves: Array<{ id: string; x: number; y: number }> = [];
    for (const item of value) {
        if (moves.length >= MAX_MOVES) {
            break;
        }
        if (!isRecord(item)) {
            continue;
        }

        if (
            typeof item.id !== 'string'
            || item.id.length === 0
            || item.id.length > MAX_ID_LENGTH
            || !isFiniteNumber(item.x)
            || !isFiniteNumber(item.y)
        ) {
            continue;
        }

        moves.push({ id: item.id, x: item.x, y: item.y });
    }
    return moves;
}

export function parseBoardJoinPayload(payload: unknown): BoardJoinPayload | null {
    if (!isRecord(payload)) {
        return null;
    }

    const boardId = asString(payload.boardId);
    const sessionId = asString(payload.sessionId);
    if (!boardId || boardId.length > MAX_BOARD_ID_LENGTH || !sessionId || sessionId.length > MAX_ID_LENGTH) {
        return null;
    }

    const shareToken = typeof payload.shareToken === 'string' ? payload.shareToken : undefined;
    const userName = typeof payload.userName === 'string' && payload.userName.trim().length > 0
        ? payload.userName.trim().slice(0, 64)
        : undefined;
    return {
        boardId,
        sessionId,
        shareToken,
        userName,
        lastSequence: normalizeSequence(payload.lastSequence),
    };
}

export function parseMutationBatchPayload(payload: unknown): MutationBatchPayload | null {
    if (!isRecord(payload)) {
        return null;
    }

    const boardId = asString(payload.boardId);
    if (!boardId || boardId.length > MAX_BOARD_ID_LENGTH || !isMutationBatch(payload.mutations)) {
        return null;
    }

    return {
        boardId,
        mutations: payload.mutations,
    };
}

export function parseCrdtUpdatePayload(payload: unknown): CrdtUpdatePayload | null {
    if (!isRecord(payload)) {
        return null;
    }

    const boardId = asString(payload.boardId);
    const update = normalizeUpdate(payload.update);
    if (!boardId || boardId.length > MAX_BOARD_ID_LENGTH || !update || update.length === 0) {
        return null;
    }

    return { boardId, update };
}

export function parsePresenceUpdatePayload(payload: unknown): PresenceUpdatePayload | null {
    if (!isRecord(payload)) {
        return null;
    }

    const boardId = asString(payload.boardId);
    if (!boardId || boardId.length > MAX_BOARD_ID_LENGTH) {
        return null;
    }

    let cursor: { x: number; y: number } | null = null;
    if (payload.cursor !== null && payload.cursor !== undefined) {
        if (!isRecord(payload.cursor) || !isFiniteNumber(payload.cursor.x) || !isFiniteNumber(payload.cursor.y)) {
            return null;
        }
        cursor = { x: payload.cursor.x, y: payload.cursor.y };
    }

    const typingField = payload.typingField === 'title' || payload.typingField === 'body'
        ? payload.typingField
        : null;

    return {
        boardId,
        cursor,
        selectedIds: parseIdList(payload.selectedIds),
        draggedIds: parseIdList(payload.draggedIds),
        focusedElementId: typeof payload.focusedElementId === 'string'
            && payload.focusedElementId.length > 0
            && payload.focusedElementId.length <= MAX_ID_LENGTH
            ? payload.focusedElementId
            : null,
        typingField,
    };
}

export function parseRealtimeTickPayload(payload: unknown): RealtimeTickPayload | null {
    if (!isRecord(payload)) {
        return null;
    }

    const boardId = asString(payload.boardId);
    if (!boardId || boardId.length > MAX_BOARD_ID_LENGTH) {
        return null;
    }

    const tickId = normalizeSequence(payload.tickId);
    let cursor: { x: number; y: number } | null = null;
    if (payload.cursor !== null && payload.cursor !== undefined) {
        if (!isRecord(payload.cursor) || !isFiniteNumber(payload.cursor.x) || !isFiniteNumber(payload.cursor.y)) {
            return null;
        }
        cursor = { x: payload.cursor.x, y: payload.cursor.y };
    }

    const typingField = payload.typingField === 'title' || payload.typingField === 'body'
        ? payload.typingField
        : null;
    const presenceState = payload.presenceState === 'away' || payload.presenceState === 'interacting'
        ? payload.presenceState
        : 'active';

    return {
        boardId,
        tickId,
        cursor,
        selectedIds: parseIdList(payload.selectedIds),
        draggedIds: parseIdList(payload.draggedIds),
        focusedElementId: typeof payload.focusedElementId === 'string'
            && payload.focusedElementId.length > 0
            && payload.focusedElementId.length <= MAX_ID_LENGTH
            ? payload.focusedElementId
            : null,
        typingField,
        presenceState,
        presenceMessage: typeof payload.presenceMessage === 'string'
            && payload.presenceMessage.length > 0
            && payload.presenceMessage.length <= MAX_PRESENCE_MESSAGE_LENGTH
            ? payload.presenceMessage
            : null,
        moves: parseMoves(payload.moves),
    };
}
