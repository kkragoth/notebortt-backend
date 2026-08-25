import { createDocument  } from 'zod-openapi';
import { z } from 'zod';
import type {oas31} from 'zod-openapi';
import {
    authCallbackQuerySchema,
    boardAccessQuerySchema,
    boardResponseSchema,
    createBoardBodySchema,
    createBoardInviteBodySchema,
    createWorkspaceBodySchema,
    createWorkspaceInvitationBodySchema,
    devLoginBodySchema,
    refreshTokenCookieSchema,
    rotateBoardLinkSharingBodySchema,
    setBoardLinkSharingBodySchema,
    updateBoardMemberPermissionBodySchema,
} from '@/shared/openapi/schemas.js';
import { mutationsBodySchema, patchElementsBodySchema } from '@/modules/boards/index.js';

export const healthResponseSchema = z.object({
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
}).meta({ id: 'HealthResponse' });

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
}).meta({ id: 'DebugStateResponse' });

const userProfileSchema = z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
}).meta({ id: 'UserProfile' });

const boardElementsResponseSchema = z.object({
    elements: z.record(z.string(), z.unknown()),
    lastSequence: z.number().int(),
}).meta({ id: 'BoardElementsResponse' });

const mutationBatchResponseSchema = z.object({
    results: z.array(z.object({
        mutationId: z.string(),
        status: z.enum(['applied', 'already_applied', 'rejected']),
        sequence: z.number().int().optional(),
        serverTimestamp: z.number().int().optional(),
        error: z.string().optional(),
        change: z.unknown().optional(),
    })),
}).meta({ id: 'MutationBatchResponse' });

const membersListSchema = z.object({
    members: z.array(z.record(z.string(), z.unknown())),
}).meta({ id: 'MembersList' });

const invitesListSchema = z.object({
    invites: z.array(z.record(z.string(), z.unknown())),
}).meta({ id: 'InvitesList' });

const boardsListSchema = z.object({
    boards: z.array(boardResponseSchema),
});

/** Provider-shaped payloads (Stripe session URLs, portal redirects). */
const providerPayloadSchema = z.record(z.string(), z.unknown());

/**
 * Ops/infra and internal surfaces that are mounted live but intentionally
 * excluded from the public OpenAPI document.
 */
export const INTERNAL_ROUTE_PATHS = new Set([
    '/debug/state',
    '/metrics',
    '/openapi.json',
    '/swagger',
    '/billing/webhook',
]);

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

            // ── P4 contract coverage: previously undocumented live routes ──
            '/auth/google': {
                get: {
                    summary: 'Start Google OAuth (PKCE + state cookies)',
                    responses: {
                        '302': { description: 'Redirect to the Google consent screen' },
                    },
                },
            },
            '/users/me': {
                get: {
                    summary: 'Current user profile',
                    responses: {
                        '200': {
                            description: 'Authenticated user',
                            content: { 'application/json': { schema: userProfileSchema } },
                        },
                        '401': { description: 'Missing or invalid access token' },
                    },
                },
            },
            '/billing/profile': {
                get: {
                    summary: 'Current billing profile for the authenticated user',
                    responses: {
                        '200': {
                            description: 'Billing provider profile payload',
                            content: { 'application/json': { schema: providerPayloadSchema } },
                        },
                    },
                },
            },
            '/billing/checkout': {
                post: {
                    summary: 'Start a Stripe checkout session',
                    responses: {
                        '200': {
                            description: 'Checkout session payload (checkout URL)',
                            content: { 'application/json': { schema: providerPayloadSchema } },
                        },
                    },
                },
            },
            '/billing/portal': {
                post: {
                    summary: 'Open the Stripe customer portal session',
                    responses: {
                        '200': {
                            description: 'Portal session payload (portal URL)',
                            content: { 'application/json': { schema: providerPayloadSchema } },
                        },
                    },
                },
            },
            '/workspaces/{wid}/members': {
                get: {
                    summary: 'List workspace members',
                    requestParams: {
                        query: z.object({}).passthrough(),
                    },
                    parameters: [],
                    responses: {
                        '200': {
                            description: 'Workspace member records',
                            content: { 'application/json': { schema: membersListSchema } },
                        },
                    },
                },
            },
            '/workspaces/{wid}/members/{memberId}': {
                delete: {
                    summary: 'Remove a workspace member',
                    requestParams: {
                        path: z.object({ wid: z.string().uuid(), memberId: z.string().uuid() }),
                    },
                    responses: {
                        '200': { description: 'Member removed' },
                    },
                },
            },
            '/invitations/{token}': {
                get: {
                    summary: 'Inspect a workspace invitation by token',
                    requestParams: {
                        path: z.object({ token: z.string().min(1) }),
                    },
                    responses: {
                        '200': {
                            description: 'Invitation record',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/invitations/{token}/accept': {
                post: {
                    summary: 'Accept a workspace invitation by token',
                    requestParams: {
                        path: z.object({ token: z.string().min(1) }),
                    },
                    responses: {
                        '200': {
                            description: 'Accepted invitation result',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/boards': {
                get: {
                    summary: 'List boards visible to the authenticated user',
                    requestParams: {
                        query: boardAccessQuerySchema,
                    },
                    responses: {
                        '200': {
                            description: 'Board list',
                            content: { 'application/json': { schema: boardsListSchema } },
                        },
                    },
                },
            },
            '/boards/{id}/elements': {
                get: {
                    summary: 'Read current board elements and sequence',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                        query: boardAccessQuerySchema,
                    },
                    responses: {
                        '200': {
                            description: 'Element map and last sequence',
                            content: { 'application/json': { schema: boardElementsResponseSchema } },
                        },
                    },
                },
                patch: {
                    summary: 'Upsert/delete elements as a mutation batch',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                        query: boardAccessQuerySchema,
                    },
                    requestBody: {
                        content: { 'application/json': { schema: patchElementsBodySchema } },
                    },
                    responses: {
                        '200': {
                            description: 'Latest applied sequence/timestamp envelope',
                            content: {
                                'application/json': {
                                    schema: z.object({
                                        ok: z.boolean(),
                                        sequence: z.number().int(),
                                        serverTimestamp: z.number().int(),
                                    }),
                                },
                            },
                        },
                    },
                },
            },
            '/boards/{id}/mutations': {
                post: {
                    summary: 'Apply an explicit mutation batch',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                        query: boardAccessQuerySchema,
                    },
                    requestBody: {
                        content: { 'application/json': { schema: mutationsBodySchema } },
                    },
                    responses: {
                        '200': {
                            description: 'Per-mutation results',
                            content: { 'application/json': { schema: mutationBatchResponseSchema } },
                        },
                    },
                },
            },
            '/boards/{id}/preview-jobs': {
                post: {
                    summary: 'Request a preview regeneration job for the board',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '202': {
                            description: 'Preview job accepted/enqueued',
                            content: {
                                'application/json': { schema: z.record(z.string(), z.unknown()) },
                            },
                        },
                    },
                },
            },
            '/boards/{id}/active-users': {
                get: {
                    summary: 'Active viewer sessions on the board',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'Active user count/session info',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/boards/{id}/presence': {
                post: {
                    summary: 'Report presence state for a viewer session',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'Presence accepted',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/boards/{id}/presence/{sessionId}': {
                delete: {
                    summary: 'End a viewer presence session',
                    requestParams: {
                        path: z.object({ id: z.string(), sessionId: z.string() }),
                    },
                    responses: {
                        '200': { description: 'Presence session removed' },
                    },
                },
            },
            '/shared/{token}': {
                get: {
                    summary: 'Resolve a share link token to its board',
                    requestParams: {
                        path: z.object({ token: z.string().min(1) }),
                    },
                    responses: {
                        '200': {
                            description: 'Board with granted permission',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/boards/{id}/duplicate': {
                post: {
                    summary: 'Duplicate a board into a new board owned by the caller',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'The duplicated board',
                            content: { 'application/json': { schema: boardResponseSchema } },
                        },
                    },
                },
            },
            '/boards/{id}/favorite': {
                put: {
                    summary: 'Mark the board as favorite',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'Updated board',
                            content: { 'application/json': { schema: boardResponseSchema } },
                        },
                    },
                },
                delete: {
                    summary: 'Unmark the board as favorite',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'Updated board',
                            content: { 'application/json': { schema: boardResponseSchema } },
                        },
                    },
                },
            },
            '/boards/{id}/leave': {
                post: {
                    summary: 'Leave a shared board',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'Leave confirmation',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/boards/{id}/members': {
                get: {
                    summary: 'List board members',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    responses: {
                        '200': {
                            description: 'Board member records',
                            content: { 'application/json': { schema: membersListSchema } },
                        },
                    },
                },
                post: {
                    summary: 'Add a board member',
                    requestParams: {
                        path: z.object({ id: z.string() }),
                    },
                    requestBody: {
                        content: { 'application/json': { schema: updateBoardMemberPermissionBodySchema } },
                    },
                    responses: {
                        '200': {
                            description: 'Board member records after add',
                            content: { 'application/json': { schema: membersListSchema } },
                        },
                    },
                },
            },
            '/boards/invites/{token}/accept': {
                post: {
                    summary: 'Accept a board invite by token',
                    requestParams: {
                        path: z.object({ token: z.string().min(1) }),
                    },
                    responses: {
                        '200': {
                            description: 'Accepted board invite result',
                            content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
                        },
                    },
                },
            },
            '/sharing/pending-invites': {
                get: {
                    summary: 'Pending invites for the authenticated user',
                    requestParams: {
                        query: z.object({}).passthrough(),
                    },
                    responses: {
                        '200': {
                            description: 'Pending invite records',
                            content: { 'application/json': { schema: invitesListSchema } },
                        },
                    },
                },
            },
            '/sharing/pending-invites/{token}': {
                delete: {
                    summary: 'Decline/cancel a pending invite by token',
                    requestParams: {
                        path: z.object({ token: z.string().min(1) }),
                    },
                    responses: {
                        '200': { description: 'Invite removed' },
                    },
                },
            },
            '/boards/{id}/invites/{inviteId}': {
                delete: {
                    summary: 'Revoke a pending board invite',
                    requestParams: {
                        path: z.object({ id: z.string(), inviteId: z.string() }),
                    },
                    responses: {
                        '200': { description: 'Invite revoked' },
                    },
                },
            },
        },
    });
}
