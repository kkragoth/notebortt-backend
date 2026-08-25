import { z } from 'zod';
import type { Request, Response } from 'express';
import type { BoardService } from '../board.service.js';
import type { WorkspaceService } from '@/modules/workspaces/index.js';
import type { BoardStateService, Mutation ,MutationProcessor } from '@/modules/collaboration/index.js';
import type { AuthService } from '@/modules/auth/index.js';
import type { PreviewJobService } from '@/modules/previews/index.js';
import type { AppEventBus } from '@/shared/events.js';
import {  MutationType } from '@/modules/collaboration/index.js';
import { sendBadRequest } from '@/shared/http.js';
import { parseWithSchema } from '@/shared/validation.js';

export interface BoardRouteDeps {
  boardService: BoardService
  workspaceService: WorkspaceService
  boardStateService: BoardStateService
  mutationProcessor: MutationProcessor
  authService: AuthService
  previewJobService: PreviewJobService
  events: AppEventBus
}

const uuidParamSchema = z.string().trim().uuid();

export const boardIdParamsSchema = z.object({
    id: uuidParamSchema,
});

export const workspaceIdParamsSchema = z.object({
    wid: uuidParamSchema,
});

export const boardMemberParamsSchema = z.object({
    id: uuidParamSchema,
    memberId: uuidParamSchema,
});

export const boardInviteParamsSchema = z.object({
    id: uuidParamSchema,
    inviteId: uuidParamSchema,
});

export const inviteTokenParamsSchema = z.object({
    token: z.string().trim().min(1),
});

export const presenceParamsSchema = z.object({
    id: uuidParamSchema,
    sessionId: z.string().trim().min(1),
});

export const boardAccessQuerySchema = z.object({
    shareToken: z.string().trim().min(1).optional(),
});

export const patchElementsBodySchema = z.object({
    upserts: z.array(z.unknown()),
    deletes: z.array(z.unknown()),
    sessionId: z.string().trim().min(1).optional(),
}).refine((value) => value.upserts.length > 0 || value.deletes.length > 0, {
    message: 'upserts and deletes must be arrays and at least one change is required',
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isMutation(value: unknown): value is Mutation {
    if (!isRecord(value)) {
        return false;
    }

    if (
        typeof value.mutationId !== 'string'
    || typeof value.boardId !== 'string'
    || typeof value.clientTimestamp !== 'number'
    || !Number.isFinite(value.clientTimestamp)
    ) {
        return false;
    }

    if (!isRecord(value.operation) || typeof value.operation.type !== 'string') {
        return false;
    }

    switch (value.operation.type) {
        case MutationType.CREATE_ELEMENT:
            return typeof value.operation.elementId === 'string' && isRecord(value.operation.data);
        case MutationType.UPDATE_ELEMENT:
            return typeof value.operation.elementId === 'string' && isRecord(value.operation.fields);
        case MutationType.DELETE_ELEMENTS:
            return isStringArray(value.operation.elementIds);
        case MutationType.MOVE_ELEMENTS:
            return Array.isArray(value.operation.moves);
        case MutationType.UPDATE_ELEMENTS:
            return Array.isArray(value.operation.updates);
        case MutationType.REORDER_ELEMENT:
            return typeof value.operation.elementId === 'string'
        && typeof value.operation.zIndex === 'number'
        && Number.isFinite(value.operation.zIndex);
        case MutationType.RECONCILE_MONTH_RANGE:
            return typeof value.operation.metaId === 'string'
        && Array.isArray(value.operation.upserts)
        && value.operation.upserts.length > 0
        && value.operation.upserts.every((item) => isRecord(item))
        && isStringArray(value.operation.deletes);
        default:
            return false;
    }
}

const mutationSchema = z.custom<Mutation>((value) => isMutation(value), {
    message: 'Invalid mutation payload',
// Metadata lets zod-openapi serialize the custom validator in the document.
}).meta({ description: 'Single board mutation (create/update/delete/move/reorder/month-range reconcile)' });

export const mutationsBodySchema = z.object({
    mutations: z.array(mutationSchema).min(1).max(100),
    sessionId: z.string().trim().min(1).optional(),
});

export const presenceBodySchema = z.object({
    sessionId: z.string().trim().min(1),
});

export const upsertBoardMemberBodySchema = z.object({
    userId: uuidParamSchema,
    permission: z.enum(['view', 'edit']).optional(),
});

export function parseOrSendBadRequest<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    input: unknown,
    res: Response,
): z.infer<TSchema> | null {
    const parsed = parseWithSchema(schema, input);
    if (!parsed.success) {
        sendBadRequest(res, parsed.error.error);
        return null;
    }

    return parsed.data;
}

export async function getWorkspaceRoleForBoard(deps: BoardRouteDeps, boardId: string, userId: string): Promise<string | null> {
    const board = await deps.boardService.getBoard(boardId);
    if (!board) {
        return null;
    }

    return deps.workspaceService.getWorkspaceMemberRole(board.workspaceId, userId);
}

export async function requireBoardAccess(
    deps: BoardRouteDeps,
    boardId: string,
    userId: string | undefined,
    shareToken?: string,
) {
    return deps.boardService.checkBoardAccess(boardId, userId, shareToken);
}

export function canCreateBoards(role: string | null): boolean {
    return role === 'owner' || role === 'admin' || role === 'editor';
}

export function canManageBoardAccess(role: string | null): boolean {
    return role === 'owner' || role === 'admin';
}

export function canDeleteBoards(role: string | null): boolean {
    return role === 'owner' || role === 'admin';
}

export function anonymousActorId(req: Request, sessionId?: string): string {
    return req.userId ?? `anonymous:${sessionId ?? 'unknown'}`;
}
