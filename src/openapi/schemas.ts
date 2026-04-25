import 'zod-openapi'
import { z } from 'zod'

export const createWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).meta({
    description: 'Workspace name',
    example: 'Product Design',
  }),
  avatarShortcut: z.string().trim().max(4).optional().meta({
    description: 'Workspace avatar shortcut',
    example: 'PD',
  }),
  gradientFrom: z.string().trim().min(1).optional().meta({
    description: 'Gradient start color',
    example: '#34d399',
  }),
  gradientTo: z.string().trim().min(1).optional().meta({
    description: 'Gradient end color',
    example: '#3b82f6',
  }),
  gradientPresetId: z.string().trim().optional().nullable().meta({
    description: 'Optional gradient preset identifier',
    example: 'emerald-ocean',
  }),
  itemTypeOrder: z.array(z.enum(['canvas', 'journal', 'graph'])).min(1).optional().meta({
    description: 'Workspace sidebar type order',
    example: ['canvas', 'journal', 'graph'],
  }),
}).meta({ id: 'CreateWorkspaceBody' })

export const patchWorkspaceBodySchema = z.object({
  name: z.string().trim().min(1).optional().meta({
    description: 'Workspace name',
    example: 'Product Design',
  }),
  avatarShortcut: z.string().trim().max(4).optional().nullable().meta({
    description: 'Workspace avatar shortcut',
    example: 'PD',
  }),
  gradientFrom: z.string().trim().min(1).optional().nullable().meta({
    description: 'Gradient start color',
    example: '#34d399',
  }),
  gradientTo: z.string().trim().min(1).optional().nullable().meta({
    description: 'Gradient end color',
    example: '#3b82f6',
  }),
  gradientPresetId: z.string().trim().optional().nullable().meta({
    description: 'Optional gradient preset identifier',
    example: 'emerald-ocean',
  }),
  itemTypeOrder: z.array(z.enum(['canvas', 'journal', 'graph'])).min(1).optional().meta({
    description: 'Workspace sidebar type order',
    example: ['canvas', 'journal', 'graph'],
  }),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
}).meta({ id: 'PatchWorkspaceBody' })

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

export const createWorkspaceItemBodySchema = z.object({
  type: z.enum(['canvas', 'journal', 'graph']).meta({
    description: 'Workspace item type',
    example: 'journal',
  }),
  name: z.string().trim().min(1).meta({
    description: 'Workspace item name',
    example: 'Workout Log',
  }),
  avatarShortcut: z.string().trim().max(4).optional().meta({
    description: 'Item avatar shortcut',
    example: 'WL',
  }),
  avatarColor: z.string().trim().min(1).optional().meta({
    description: 'Item avatar color token',
    example: 'green',
  }),
}).meta({ id: 'CreateWorkspaceItemBody' })

export const patchWorkspaceItemBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'archived']).optional(),
  avatarShortcut: z.string().trim().max(4).optional().nullable(),
  avatarColor: z.string().trim().min(1).optional().nullable(),
  sidebarOrder: z.number().int().min(0).optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
}).meta({ id: 'PatchWorkspaceItemBody' })

export const reorderWorkspaceItemsBodySchema = z.object({
  orderedItemIds: z.array(z.string().uuid()).min(1),
  typeOrder: z.array(z.enum(['canvas', 'journal', 'graph'])).optional(),
}).meta({ id: 'ReorderWorkspaceItemsBody' })

export const createJournalNoteBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  bodyJson: z.unknown().optional(),
  bodyText: z.string().optional(),
  excerpt: z.string().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  color: z.string().trim().min(1).optional().nullable(),
  colorTitle: z.boolean().optional(),
}).meta({ id: 'CreateJournalNoteBody' })

export const patchJournalNoteBodySchema = z.object({
  title: z.string().trim().min(1).optional(),
  bodyJson: z.unknown().optional(),
  bodyText: z.string().optional(),
  excerpt: z.string().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  color: z.string().trim().min(1).optional().nullable(),
  colorTitle: z.boolean().optional(),
  pinned: z.boolean().optional(),
  status: z.enum(['active', 'archived']).optional(),
  updatedAt: z.string().datetime().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
}).meta({ id: 'PatchJournalNoteBody' })

export const sendJournalNoteToCanvasBodySchema = z.object({
  canvasBoardId: z.string().uuid(),
  targetContainerId: z.string().trim().min(1).optional(),
  targetElementId: z.string().trim().min(1).optional(),
  mode: z.enum(['synced', 'snapshot', 'plain_text']).default('synced'),
}).meta({ id: 'SendJournalNoteToCanvasBody' })

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
