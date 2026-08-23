import { z } from 'zod';
import type { BoardElement, Mutation, MutationResult, PersistedElementChange  } from '@/modules/collaboration/index.js';

// Client → Server
export type ClientMessage =
  | { type: 'MUTATION'; mutation: Mutation }
  | {
      type: 'PRESENCE'
      cursor: { x: number; y: number } | null
      selectedIds?: string[]
      draggedIds?: string[]
      focusedElementId?: string | null
      typingField?: 'title' | 'body' | null
    }
  | { type: 'PONG' }

// Server → Client
export type ServerMessage =
  | { type: 'MUTATION'; mutation: Mutation; fromUserId: string }
  | { type: 'CATCH_UP'; changes: PersistedElementChange[] }
  | { type: 'CATCH_UP_FAILED'; reason: string }
  | { type: 'ELEMENTS_CHANGED'; change: PersistedElementChange; fromUserId: string }
  | { type: 'SNAPSHOT'; elements: Record<string, BoardElement>; lastSequence: number }
  | {
      type: 'PRESENCE'
      sessionId: string
      userId: string
      cursor: { x: number; y: number } | null
      selectedIds: string[]
      draggedIds?: string[]
      focusedElementId?: string | null
      typingField?: 'title' | 'body' | null
      userName: string
      avatarUrl: string | null
      color: string
    }
  | { type: 'USER_JOINED'; sessionId: string; userId: string; userName: string; avatarUrl: string | null; color: string }
  | { type: 'USER_LEFT'; sessionId: string; userId: string }
  | { type: 'UPGRADE'; message: string }
  | { type: 'DOWNGRADE'; message: string }
  | { type: 'PING' }
  | { type: 'RATE_LIMITED' }
  | { type: 'MUTATION_RESULT'; result: MutationResult }
  | { type: 'ERROR'; message: string }

export interface PresenceData {
  cursor: { x: number; y: number } | null
  selectedIds: string[]
  userName: string
  avatarUrl: string | null
  color: string
}

const MAX_MESSAGE_CHARS = 128_000;
const MAX_ID_LENGTH = 200;
const MAX_LIST_ITEMS = 250;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const boardElementSchema = z.object({
    id: idSchema,
    kind: z.string().min(1).max(80),
    x: z.number(),
    y: z.number(),
    zIndex: z.number(),
    updatedAt: z.number(),
}).passthrough();

const mutationSchema = z.object({
    mutationId: idSchema,
    boardId: idSchema,
    clientTimestamp: z.number(),
    serverTimestamp: z.number().optional(),
    sequence: z.number().optional(),
    operation: z.discriminatedUnion('type', [
        z.object({
            type: z.literal('CREATE_ELEMENT'),
            elementId: idSchema,
            data: boardElementSchema,
        }),
        z.object({
            type: z.literal('UPDATE_ELEMENT'),
            elementId: idSchema,
            fields: z.record(z.string(), z.unknown()),
        }),
        z.object({
            type: z.literal('DELETE_ELEMENTS'),
            elementIds: z.array(idSchema).max(MAX_LIST_ITEMS),
        }),
        z.object({
            type: z.literal('MOVE_ELEMENTS'),
            moves: z.array(z.object({
                elementId: idSchema,
                x: z.number(),
                y: z.number(),
            })).max(MAX_LIST_ITEMS),
            transient: z.boolean().optional(),
        }),
        z.object({
            type: z.literal('UPDATE_ELEMENTS'),
            updates: z.array(z.object({
                elementId: idSchema,
                fields: z.record(z.string(), z.unknown()),
            })).max(MAX_LIST_ITEMS),
        }),
        z.object({
            type: z.literal('REORDER_ELEMENT'),
            elementId: idSchema,
            zIndex: z.number(),
        }),
    ]),
});

const presenceMessageSchema = z.object({
    type: z.literal('PRESENCE'),
    cursor: z.object({
        x: z.number(),
        y: z.number(),
    }).nullable(),
    selectedIds: z.array(idSchema).max(MAX_LIST_ITEMS).optional(),
    draggedIds: z.array(idSchema).max(MAX_LIST_ITEMS).optional(),
    focusedElementId: idSchema.nullable().optional(),
    typingField: z.enum(['title', 'body']).nullable().optional(),
});

const clientMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('MUTATION'),
        mutation: mutationSchema,
    }),
    presenceMessageSchema,
    z.object({
        type: z.literal('PONG'),
    }),
]);

export function serialize(msg: ServerMessage): string {
    return JSON.stringify(msg);
}

export function parseClientMessage(raw: string): ClientMessage | null {
    if (raw.length > MAX_MESSAGE_CHARS) {
        return null;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        const result = clientMessageSchema.safeParse(parsed);
        if (!result.success) {
            return null;
        }
        return result.data as ClientMessage;
    } catch {
        return null;
    }
}
