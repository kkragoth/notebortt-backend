import { createDocument, type oas31 } from 'zod-openapi'
import { z } from 'zod'
import {
  authCallbackQuerySchema,
  boardAccessQuerySchema,
  boardResponseSchema,
  createBoardBodySchema,
  createBoardInviteBodySchema,
  createWorkspaceBodySchema,
  createWorkspaceInvitationBodySchema,
  devLoginBodySchema,
  debugStateQuerySchema,
  refreshTokenCookieSchema,
  rotateBoardLinkSharingBodySchema,
  setBoardLinkSharingBodySchema,
  updateBoardMemberPermissionBodySchema,
} from './schemas.js'

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']).meta({ example: 'ok' }),
  postgres: z.enum(['ok', 'error']).meta({ example: 'ok' }),
  redis: z.enum(['ok', 'error']).meta({ example: 'ok' }),
  uptime: z.number().int().meta({ example: 412 }),
  openWebSocketConnections: z.number().int().nonnegative().meta({ example: 3 }),
  boardState: z.object({
    dirtyBacklog: z.number().int().nonnegative().meta({ example: 0 }),
    lastDirtyAt: z.number().int().nullable().meta({ example: null }),
    timeSinceLastDirtyMs: z.number().int().nonnegative().nullable().meta({ example: null }),
  }),
}).meta({ id: 'HealthResponse' })

const debugStateResponseSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']),
  postgres: z.object({
    counts: z.object({
      users: z.number().int(),
      workspaces: z.number().int(),
      boards: z.number().int(),
      elements: z.number().int(),
      mutations: z.number().int(),
    }).nullable(),
    recentBoards: z.array(z.record(z.string(), z.unknown())),
  }),
  redis: z.object({
    dbSize: z.number().int(),
    keyPattern: z.string(),
    sampledKeys: z.array(z.string()),
    boardState: z.object({
      sequence: z.string().nullable(),
      clientCount: z.number().int(),
      elementCount: z.number().int(),
      lastActive: z.string().nullable(),
    }).nullable(),
    memory: z.array(z.string()),
  }),
}).meta({ id: 'DebugStateResponse' })

export function createOpenApiDocument(): oas31.OpenAPIObject {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'note-canva backend',
      version: '1.0.0',
      description: 'Backend API documentation generated from Zod schemas.',
    },
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          responses: {
            '200': {
              description: 'Healthy services',
              content: {
                'application/json': { schema: healthResponseSchema },
              },
            },
            '503': {
              description: 'At least one dependency is degraded',
              content: {
                'application/json': { schema: healthResponseSchema },
              },
            },
          },
        },
      },
      '/debug/state': {
        get: {
          summary: 'Development-only runtime state',
          requestParams: {
            query: debugStateQuerySchema,
          },
          responses: {
            '200': {
              description: 'Current SQL and Redis state summary',
              content: {
                'application/json': { schema: debugStateResponseSchema },
              },
            },
          },
        },
      },
      '/workspaces': {
        post: {
          summary: 'Create workspace',
          requestBody: {
            content: {
              'application/json': { schema: createWorkspaceBodySchema },
            },
          },
          responses: {
            '201': { description: 'Workspace created' },
          },
        },
      },
      '/workspaces/{wid}': {
        patch: {
          summary: 'Rename workspace',
          requestParams: {
            path: z.object({
              wid: z.string().meta({
                description: 'Workspace id',
                example: 'workspace-123',
              }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: createWorkspaceBodySchema },
            },
          },
          responses: {
            '200': { description: 'Workspace updated' },
          },
        },
      },
      '/auth/callback': {
        get: {
          summary: 'OAuth callback',
          requestParams: {
            query: authCallbackQuerySchema,
          },
          responses: {
            '302': { description: 'Redirects back to the frontend after setting secure auth cookies' },
          },
        },
      },
      '/auth/dev-login': {
        post: {
          summary: 'Development-only login',
          requestBody: {
            content: {
              'application/json': { schema: devLoginBodySchema },
            },
          },
          responses: {
            '200': { description: 'Sets secure auth cookies and returns user profile' },
          },
        },
      },
      '/auth/refresh': {
        post: {
          summary: 'Refresh access token',
          requestParams: {
            cookie: refreshTokenCookieSchema,
          },
          responses: {
            '200': { description: 'Rotates auth cookies' },
            '401': { description: 'Missing or invalid refresh token' },
          },
        },
      },
      '/auth/logout': {
        post: {
          summary: 'Logout',
          requestParams: {
            cookie: refreshTokenCookieSchema.partial(),
          },
          responses: {
            '200': { description: 'Clears refresh token cookie' },
          },
        },
      },
      '/workspaces/{wid}/invitations': {
        post: {
          summary: 'Invite a workspace member',
          requestParams: {
            path: z.object({
              wid: z.string().meta({
                description: 'Workspace id',
                example: 'workspace-123',
              }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: createWorkspaceInvitationBodySchema },
            },
          },
          responses: {
            '201': { description: 'Invitation created' },
          },
        },
      },
      '/workspaces/{wid}/boards': {
        post: {
          summary: 'Create board',
          requestParams: {
            path: z.object({
              wid: z.string().meta({
                description: 'Workspace id',
                example: 'workspace-123',
              }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: createBoardBodySchema },
            },
          },
          responses: {
            '201': { description: 'Board created' },
          },
        },
      },
      '/boards/{id}': {
        get: {
          summary: 'Get a board with resolved access permission',
          requestParams: {
            path: z.object({
              id: z.string().meta({ description: 'Board id', example: 'board-123' }),
            }),
            query: boardAccessQuerySchema,
          },
          responses: {
            '200': {
              description: 'Board with resolved permission for the requester or share token',
              content: {
                'application/json': { schema: boardResponseSchema },
              },
            },
            '403': { description: 'No access to the board' },
            '404': { description: 'Board not found' },
          },
        },
      },
      '/boards/{id}/invites': {
        post: {
          summary: 'Invite a board collaborator',
          requestParams: {
            path: z.object({
              id: z.string().meta({
                description: 'Board id',
                example: 'board-123',
              }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: createBoardInviteBodySchema },
            },
          },
          responses: {
            '201': { description: 'Board invitation created' },
          },
        },
      },
      '/boards/{id}/members/{memberId}': {
        patch: {
          summary: 'Update board member permission',
          requestParams: {
            path: z.object({
              id: z.string().meta({ description: 'Board id', example: 'board-123' }),
              memberId: z.string().meta({ description: 'Board member id', example: 'member-123' }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: updateBoardMemberPermissionBodySchema },
            },
          },
          responses: {
            '204': { description: 'Member updated' },
          },
        },
      },
      '/boards/{id}/link-sharing': {
        patch: {
          summary: 'Set board link-sharing policy for a permission (view or edit)',
          requestParams: {
            path: z.object({
              id: z.string().meta({ description: 'Board id', example: 'board-123' }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: setBoardLinkSharingBodySchema },
            },
          },
          responses: {
            '200': { description: 'Link sharing updated' },
          },
        },
      },
      '/boards/{id}/link-sharing/rotate': {
        post: {
          summary: 'Rotate the link token for a permission (view or edit)',
          requestParams: {
            path: z.object({
              id: z.string().meta({ description: 'Board id', example: 'board-123' }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: rotateBoardLinkSharingBodySchema },
            },
          },
          responses: {
            '200': { description: 'Link token rotated' },
          },
        },
      },
    },
  })
}
