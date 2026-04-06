import 'zod-openapi'
import { z } from 'zod'

export const createWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).meta({
    description: 'Workspace name',
    example: 'Product Design',
  }),
}).meta({ id: 'CreateWorkspaceBody' })

export const createWorkspaceInvitationBodySchema = z.object({
  email: z.email().meta({
    description: 'Email address to invite',
    example: 'teammate@example.com',
  }),
  role: z.enum(['owner', 'admin', 'member']).optional().meta({
    description: 'Workspace role for the invited user',
    example: 'member',
  }),
}).meta({ id: 'CreateWorkspaceInvitationBody' })

export const createBoardBodySchema = z.object({
  name: z.string().trim().min(1).meta({
    description: 'Board name',
    example: 'Sprint Planning',
  }),
}).meta({ id: 'CreateBoardBody' })

export const createBoardInviteBodySchema = z.object({
  email: z.email().meta({
    description: 'Email address to invite to the board',
    example: 'editor@example.com',
  }),
  role: z.enum(['editor', 'viewer']).optional().meta({
    description: 'Board invite role',
    example: 'viewer',
  }),
}).meta({ id: 'CreateBoardInviteBody' })

export const updateBoardSharePermissionBodySchema = z.object({
  permission: z.enum(['view', 'edit']).meta({
    description: 'Shared permission',
    example: 'edit',
  }),
}).meta({ id: 'UpdateBoardSharePermissionBody' })

export const debugStateQuerySchema = z.object({
  boardId: z.string().optional().meta({
    description: 'Inspect Redis state for a single board',
    example: 'f4b29acb-8c50-4a9b-a4e8-a9fd3811c3f1',
  }),
  limit: z.coerce.number().int().positive().max(100).optional().meta({
    description: 'Max number of recent boards or sampled keys to return',
    example: 20,
  }),
}).meta({ id: 'DebugStateQuery' })

export const authCallbackQuerySchema = z.object({
  code: z.string().min(1).meta({
    description: 'Google OAuth authorization code',
    example: '4/0AQSTgQF...',
  }),
}).meta({ id: 'AuthCallbackQuery' })

export const devLoginBodySchema = z.object({
  email: z.email().meta({
    description: 'Email to log in as in development mode',
    example: 'demo@example.com',
  }),
}).meta({ id: 'DevLoginBody' })

export const refreshTokenCookieSchema = z.object({
  refreshToken: z.string().min(1).meta({
    description: 'Refresh token cookie value',
    example: 'abc123',
  }),
}).meta({ id: 'RefreshTokenCookie' })
