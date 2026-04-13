import { z } from 'zod'
import type { Request, Response } from 'express'
import { parseWithSchema } from '../../lib/validation.js'
import { sendBadRequest } from '../../lib/http.js'
import type { BoardService } from '../../services/board.service.js'
import type { WorkspaceService } from '../../services/workspace.service.js'
import type { BoardStateService } from '../../services/board-state.service.js'
import type { MutationProcessor } from '../../mutations/processor.js'
import { MutationType, type Mutation } from '../../mutations/types.js'
import type { AuthService } from '../../services/auth.service.js'
import type { PreviewJobService } from '../../services/preview-job.service.js'

export interface BoardRouteDeps {
  boardService: BoardService
  workspaceService: WorkspaceService
  boardStateService: BoardStateService
  mutationProcessor: MutationProcessor
  authService: AuthService
  previewJobService: PreviewJobService
}

export const boardIdParamsSchema = z.object({
  id: z.string().trim().min(1),
})

export const workspaceIdParamsSchema = z.object({
  wid: z.string().trim().min(1),
})

export const boardMemberParamsSchema = z.object({
  id: z.string().trim().min(1),
  memberId: z.string().trim().min(1),
})

export const boardInviteParamsSchema = z.object({
  id: z.string().trim().min(1),
  inviteId: z.string().trim().min(1),
})

export const inviteTokenParamsSchema = z.object({
  token: z.string().trim().min(1),
})

export const presenceParamsSchema = z.object({
  id: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
})

export const boardAccessQuerySchema = z.object({
  shareToken: z.string().trim().min(1).optional(),
})

export const patchElementsBodySchema = z.object({
  upserts: z.array(z.unknown()),
  deletes: z.array(z.unknown()),
  sessionId: z.string().trim().min(1).optional(),
}).refine((value) => value.upserts.length > 0 || value.deletes.length > 0, {
  message: 'upserts and deletes must be arrays and at least one change is required',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isMutation(value: unknown): value is Mutation {
  if (!isRecord(value)) {
    return false
  }

  if (
    typeof value.mutationId !== 'string'
    || typeof value.boardId !== 'string'
    || typeof value.clientTimestamp !== 'number'
    || !Number.isFinite(value.clientTimestamp)
  ) {
    return false
  }

  if (!isRecord(value.operation) || typeof value.operation.type !== 'string') {
    return false
  }

  switch (value.operation.type) {
    case MutationType.CREATE_ELEMENT:
      return typeof value.operation.elementId === 'string' && isRecord(value.operation.data)
    case MutationType.UPDATE_ELEMENT:
      return typeof value.operation.elementId === 'string' && isRecord(value.operation.fields)
    case MutationType.DELETE_ELEMENTS:
      return isStringArray(value.operation.elementIds)
    case MutationType.MOVE_ELEMENTS:
      return Array.isArray(value.operation.moves)
    case MutationType.UPDATE_ELEMENTS:
      return Array.isArray(value.operation.updates)
    case MutationType.REORDER_ELEMENT:
      return typeof value.operation.elementId === 'string'
        && typeof value.operation.zIndex === 'number'
        && Number.isFinite(value.operation.zIndex)
    default:
      return false
  }
}

const mutationSchema = z.custom<Mutation>((value) => isMutation(value), {
  message: 'Invalid mutation payload',
})

export const mutationsBodySchema = z.object({
  mutations: z.array(mutationSchema).min(1).max(100),
  sessionId: z.string().trim().min(1).optional(),
})

export const presenceBodySchema = z.object({
  sessionId: z.string().trim().min(1),
})

export const upsertBoardMemberBodySchema = z.object({
  userId: z.string().trim().min(1),
  permission: z.enum(['view', 'edit']).optional(),
})

export function parseOrSendBadRequest<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
  res: Response,
): z.infer<TSchema> | null {
  const parsed = parseWithSchema(schema, input)
  if (!parsed.success) {
    sendBadRequest(res, parsed.error.error)
    return null
  }

  return parsed.data
}

export async function getWorkspaceRoleForBoard(deps: BoardRouteDeps, boardId: string, userId: string): Promise<string | null> {
  const board = await deps.boardService.getBoard(boardId)
  if (!board) {
    return null
  }

  return deps.workspaceService.getWorkspaceMemberRole(board.workspaceId, userId)
}

export async function requireBoardAccess(
  deps: BoardRouteDeps,
  boardId: string,
  userId: string | undefined,
  shareToken?: string,
) {
  return deps.boardService.checkBoardAccess(boardId, userId, shareToken)
}

export function canCreateBoards(role: string | null): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor'
}

export function canManageBoardAccess(role: string | null): boolean {
  return role === 'owner' || role === 'admin'
}

export function canDeleteBoards(role: string | null): boolean {
  return role === 'owner' || role === 'admin'
}

export function anonymousActorId(req: Request, sessionId?: string): string {
  return req.userId ?? `anonymous:${sessionId ?? 'unknown'}`
}
