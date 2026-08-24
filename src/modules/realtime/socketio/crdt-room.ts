import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { BoardStateService, Mutation, MutationProcessor , PersistedElementChange  } from '@/modules/collaboration/index.js';
import { MutationType } from '@/modules/collaboration/index.js';

const DEFAULT_CRDT_DEBOUNCE_MS = 400;
const DEFAULT_CRDT_MAX_WAIT_MS = 1600;

interface CrdtRoomState {
  doc: Y.Doc
  moves: Y.Map<{ x: number; y: number }>
  pendingMoves: Map<string, { x: number; y: number }>
  debounceTimer: NodeJS.Timeout | null
  maxWaitTimer: NodeJS.Timeout | null
  flushStartedAt: number | null
  lastEditorUserId: string
}

interface CrdtRoomStoreOptions {
  debounceMs?: number
  maxWaitMs?: number
  onPersistedChange?: (boardId: string, userId: string, change: PersistedElementChange) => Promise<void>
}

export function createCrdtRoomStore(
    boardStateService: BoardStateService,
    mutationProcessor: MutationProcessor,
    options: CrdtRoomStoreOptions,
) {
    const rooms = new Map<string, CrdtRoomState>();
    const debounceMs = options.debounceMs ?? DEFAULT_CRDT_DEBOUNCE_MS;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_CRDT_MAX_WAIT_MS;

    function getOrCreateRoom(boardId: string): CrdtRoomState {
        const existing = rooms.get(boardId);
        if (existing) {
            return existing;
        }

        const doc = new Y.Doc();
        const moves = doc.getMap<{ x: number; y: number }>('moves');
        const room: CrdtRoomState = {
            doc,
            moves,
            pendingMoves: new Map<string, { x: number; y: number }>(),
            debounceTimer: null,
            maxWaitTimer: null,
            flushStartedAt: null,
            lastEditorUserId: 'system:socketio',
        };

        moves.observe((event) => {
            for (const [elementId, change] of event.changes.keys) {
                if (change.action === 'delete') {
                    continue;
                }
                const nextMove = moves.get(elementId);
                if (nextMove) {
                    room.pendingMoves.set(elementId, { x: nextMove.x, y: nextMove.y });
                }
            }
        });

        rooms.set(boardId, room);
        return room;
    }

    function clearTimers(room: CrdtRoomState): void {
        if (room.debounceTimer) {
            clearTimeout(room.debounceTimer);
            room.debounceTimer = null;
        }
        if (room.maxWaitTimer) {
            clearTimeout(room.maxWaitTimer);
            room.maxWaitTimer = null;
        }
        room.flushStartedAt = null;
    }

    async function flush(boardId: string): Promise<void> {
        const room = rooms.get(boardId);
        if (!room || room.pendingMoves.size === 0) {
            return;
        }

        clearTimers(room);

        const moves = Array.from(room.pendingMoves.entries()).map(([elementId, position]) => ({
            elementId,
            x: position.x,
            y: position.y,
        }));
        room.pendingMoves.clear();

        await boardStateService.loadBoard(boardId);
        const mutation: Mutation = {
            mutationId: randomUUID(),
            boardId,
            clientTimestamp: Date.now(),
            operation: {
                type: MutationType.MOVE_ELEMENTS,
                moves,
            },
        };

        const results = await mutationProcessor.processBatch([mutation], room.lastEditorUserId);
        for (const result of results) {
            if (result.status === 'applied' && result.change) {
                await options.onPersistedChange?.(boardId, room.lastEditorUserId, result.change);
            }
        }
    }

    function scheduleFlush(boardId: string): void {
        const room = rooms.get(boardId);
        if (!room) {
            return;
        }

        if (room.debounceTimer) {
            clearTimeout(room.debounceTimer);
        }

        room.debounceTimer = setTimeout(() => {
            room.debounceTimer = null;
            void flush(boardId);
        }, debounceMs);

        if (!room.maxWaitTimer) {
            room.flushStartedAt = Date.now();
            room.maxWaitTimer = setTimeout(() => {
                room.maxWaitTimer = null;
                void flush(boardId);
            }, maxWaitMs);
        }
    }

    function applyRemoteUpdate(boardId: string, userId: string, update: Uint8Array): void {
        const room = getOrCreateRoom(boardId);
        room.lastEditorUserId = userId;
        Y.applyUpdate(room.doc, update, userId);
        scheduleFlush(boardId);
    }

    function flushNow(boardId: string): Promise<void> {
        return flush(boardId);
    }

    function clearRoom(boardId: string): void {
        const room = rooms.get(boardId);
        if (!room) {
            return;
        }

        clearTimers(room);
        room.pendingMoves.clear();
        room.doc.destroy();
        rooms.delete(boardId);
    }

    return {
        applyRemoteUpdate,
        flushNow,
        clearRoom,
    };
}
