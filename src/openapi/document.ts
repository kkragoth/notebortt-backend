import { createDocument, type oas31 } from 'zod-openapi'
import { z } from 'zod'
import {
  authCallbackQuerySchema,
  createBoardBodySchema,
  createBoardInviteBodySchema,
  createWorkspaceBodySchema,
  createWorkspaceInvitationBodySchema,
  devLoginBodySchema,
  debugStateQuerySchema,
  refreshTokenCookieSchema,
  updateBoardSharePermissionBodySchema,
} from './schemas.js'

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']).meta({ example: 'ok' }),
  postgres: z.enum(['ok', 'error']).meta({ example: 'ok' }),
  redis: z.enum(['ok', 'error']).meta({ example: 'ok' }),
  uptime: z.number().int().meta({ example: 412 }),
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
      '/auth/callback': {
        get: {
          summary: 'OAuth callback',
          requestParams: {
            query: authCallbackQuerySchema,
          },
          responses: {
            '302': { description: 'Redirects back to the frontend with an access token' },
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
            '200': { description: 'Returns access token and user profile' },
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
            '200': { description: 'Returns a fresh access token' },
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
      '/boards/{id}/shares/{shareId}': {
        patch: {
          summary: 'Update board share permission',
          requestParams: {
            path: z.object({
              id: z.string().meta({ description: 'Board id', example: 'board-123' }),
              shareId: z.string().meta({ description: 'Share id', example: 'share-123' }),
            }),
          },
          requestBody: {
            content: {
              'application/json': { schema: updateBoardSharePermissionBodySchema },
            },
          },
          responses: {
            '204': { description: 'Share updated' },
          },
        },
      },
    },
  })
}
