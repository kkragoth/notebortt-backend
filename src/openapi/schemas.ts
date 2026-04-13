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
  role: z.enum(['admin', 'editor', 'viewer']).optional().meta({
    description: 'Workspace role for the invited user',
    example: 'viewer',
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
  permission: z.enum(['view', 'edit']).optional().meta({
    description: 'Board invite permission',
    example: 'view',
  }),
}).meta({ id: 'CreateBoardInviteBody' })

export const updateBoardMemberPermissionBodySchema = z.object({
  permission: z.enum(['view', 'edit']).meta({
    description: 'Board member permission',
    example: 'edit',
  }),
}).meta({ id: 'UpdateBoardMemberPermissionBody' })

export const setBoardLinkSharingBodySchema = z.object({
  enabled: z.boolean().meta({
    description: 'Whether link sharing is enabled',
    example: true,
  }),
  permission: z.enum(['view', 'edit']).optional().meta({
    description: 'Permission granted via link when enabled',
    example: 'edit',
  }),
}).meta({ id: 'SetBoardLinkSharingBody' })

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
  state: z.string().min(1).meta({
    description: 'OAuth state parameter for CSRF protection',
    example: 'R5B4s2g6hM6_Jm7q7w0A8A',
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
