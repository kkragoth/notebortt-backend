import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {BoardElement, Mutation} from '@/mutations/types.js';
import { createBoardRouter } from '@/routes/boards.js';
import {   MutationType } from '@/mutations/types.js';

const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'valid-token';
const INVALID_UUID = 'not-a-uuid';

function makeElement(id: string, overrides: Partial<BoardElement> = {}): BoardElement {
    return {
        id,
        kind: 'NOTE',
        x: 10,
        y: 20,
        zIndex: 1,
        updatedAt: 123,
        ...overrides,
    };
}

function cloneElements(elements: Record<string, BoardElement>): Record<string, BoardElement> {
    return JSON.parse(JSON.stringify(elements)) as Record<string, BoardElement>;
}

function cloneElement(element: BoardElement): BoardElement {
    return JSON.parse(JSON.stringify(element)) as BoardElement;
}

function createHarness(
    initialElements: Record<string, BoardElement>,
    permission: 'view' | 'edit' = 'edit',
) {
    const state = {
        elements: cloneElements(initialElements),
        sequence: 0,
    };
    const batches: Mutation[][] = [];

    const boardStateService = {
        loadBoard: async () => 0,
        getElements: async () => cloneElements(state.elements),
        peekSequence: async () => state.sequence,
    } as any;

    const mutationProcessor = {
        processBatch: async (mutations: Mutation[]) => {
            batches.push(mutations);
            const results = [];

            for (const mutation of mutations) {
                state.sequence += 1;

                switch (mutation.operation.type) {
                    case MutationType.CREATE_ELEMENT:
                        state.elements[mutation.operation.elementId] = cloneElement(mutation.operation.data);
                        break;
                    case MutationType.UPDATE_ELEMENT: {
                        const existing = state.elements[mutation.operation.elementId];
                        if (existing) {
                            state.elements[mutation.operation.elementId] = {
                                ...existing,
                                ...mutation.operation.fields,
                            };
                        }
                        break;
                    }
                    case MutationType.UPDATE_ELEMENTS:
                        for (const update of mutation.operation.updates) {
                            const existing = state.elements[update.elementId];
                            if (existing) {
                                state.elements[update.elementId] = {
                                    ...existing,
                                    ...update.fields,
                                };
                            }
                        }
                        break;
                    case MutationType.DELETE_ELEMENTS:
                        for (const elementId of mutation.operation.elementIds) {
                            delete state.elements[elementId];
                        }
                        break;
                    case MutationType.MOVE_ELEMENTS:
                        for (const move of mutation.operation.moves) {
                            const existing = state.elements[move.elementId];
                            if (existing) {
                                state.elements[move.elementId] = {
                                    ...existing,
                                    x: move.x,
                                    y: move.y,
                                };
                            }
                        }
                        break;
                    case MutationType.REORDER_ELEMENT: {
                        const existing = state.elements[mutation.operation.elementId];
                        if (existing) {
                            state.elements[mutation.operation.elementId] = {
                                ...existing,
                                zIndex: mutation.operation.zIndex,
                            };
                        }
                        break;
                    }
                }

                results.push({
                    mutationId: mutation.mutationId,
                    status: 'applied' as const,
                    sequence: state.sequence,
                    serverTimestamp: 1_700_000_000_000 + state.sequence,
                });
            }

            return results;
        },
    } as any;

    const app = express();
    app.use(express.json());
    app.use('/',
        createBoardRouter(
      {
          checkBoardAccess: async () => ({ hasAccess: true, permission }),
      } as any,
      {
          isWorkspaceMember: async () => true,
      } as any,
      (req, _res, next) => {
          req.userId = USER_ID;
          next();
      },
      boardStateService,
      mutationProcessor,
      {
          verifyAccessToken: (token: string) => {
              if (token !== TOKEN) {
                  throw new Error('invalid token');
              }

              return { sub: USER_ID };
          },
      } as any,
      {
          enqueue: async () => ({ boardId: BOARD_ID, dueAt: 1_700_000_100_000 }),
      } as any,
        ),
    );

    return { app, state, batches };
}

function createAuthScopingHarness() {
    const app = express();
    app.use(express.json());
    app.use('/', createBoardRouter(
    {
        getShareByToken: async () => ({ boardId: BOARD_ID, permission: 'view' }),
    } as any,
    {} as any,
    (req, res, next) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing authentication token' });
            return;
        }
        req.userId = USER_ID;
        next();
    },
    {} as any,
    {} as any,
    {
        verifyAccessToken: (token: string) => {
            if (token !== TOKEN) {
                throw new Error('invalid token');
            }
            return { sub: USER_ID };
        },
    } as any,
    {} as any,
    ));

    return { app };
}

describe('board router auth scoping', () => {
    it('allows anonymous access to /shared/:token', async () => {
        const { app } = createAuthScopingHarness();

        const response = await request(app).get('/shared/some-share-token');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ boardId: BOARD_ID, permission: 'view' });
    });

    it('allows authenticated access to /shared/:token', async () => {
        const { app } = createAuthScopingHarness();

        const response = await request(app)
            .get('/shared/some-share-token')
            .set('Authorization', `Bearer ${TOKEN}`);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ boardId: BOARD_ID, permission: 'view' });
    });

    it('still requires auth for management routes', async () => {
        const { app } = createAuthScopingHarness();

        const response = await request(app).get(`/workspaces/${BOARD_ID}/boards`);

        expect(response.status).toBe(401);
    });
});

describe('boards route mutation translation', () => {
    it('PATCH /boards/:id/elements and POST /boards/:id/mutations produce equivalent state transitions', async () => {
        const container = makeElement('container-1', { kind: 'COLUMN' });
        const child = makeElement('child-1', { containerId: 'container-1', containerColumnId: 'a' });
        const kept = makeElement('keep-1', { x: 99 });
        const initialElements = {
            'container-1': container,
            'child-1': child,
            'keep-1': kept,
        };

        const patchHarness = createHarness(initialElements);
        const patchPayload = {
            upserts: [
                makeElement('child-1', { containerId: 'container-1', containerColumnId: 'a', x: 42, y: 84 }),
                makeElement('new-1', { containerId: 'container-1', x: 7, y: 8 }),
            ],
            deletes: ['container-1'],
        };

        const patchResponse = await request(patchHarness.app)
            .patch(`/boards/${BOARD_ID}/elements`)
            .set('Authorization', `Bearer ${TOKEN}`)
            .send(patchPayload);

        expect(patchResponse.status).toBe(200);
        expect(patchHarness.batches).toHaveLength(1);
        expect(patchHarness.batches[0]?.map((mutation) => mutation.operation)).toEqual([
            {
                type: MutationType.DELETE_ELEMENTS,
                elementIds: ['child-1', 'container-1'],
            },
            {
                type: MutationType.CREATE_ELEMENT,
                elementId: 'new-1',
                data: makeElement('new-1', { containerId: 'container-1', x: 7, y: 8 }),
            },
        ]);

        const mutationHarness = createHarness(initialElements);
        const equivalentMutations: Mutation[] = [
            {
                mutationId: 'mutation-delete',
                boardId: BOARD_ID,
                clientTimestamp: 1,
                operation: {
                    type: MutationType.DELETE_ELEMENTS,
                    elementIds: ['child-1', 'container-1'],
                },
            },
            {
                mutationId: 'mutation-create',
                boardId: BOARD_ID,
                clientTimestamp: 2,
                operation: {
                    type: MutationType.CREATE_ELEMENT,
                    elementId: 'new-1',
                    data: makeElement('new-1', { containerId: 'container-1', x: 7, y: 8 }),
                },
            },
        ];

        const mutationResponse = await request(mutationHarness.app)
            .post(`/boards/${BOARD_ID}/mutations`)
            .set('Authorization', `Bearer ${TOKEN}`)
            .send({ mutations: equivalentMutations });

        expect(mutationResponse.status).toBe(200);
        expect(mutationResponse.body.results).toHaveLength(2);
        expect(patchResponse.body).toEqual({
            ok: true,
            sequence: mutationResponse.body.results.at(-1).sequence,
            serverTimestamp: mutationResponse.body.results.at(-1).serverTimestamp,
        });
        expect(patchHarness.state).toEqual(mutationHarness.state);
    });

    it('returns 403 for view-only access on both write endpoints', async () => {
        const harness = createHarness({}, 'view');

        const patchResponse = await request(harness.app)
            .patch(`/boards/${BOARD_ID}/elements`)
            .send({
                upserts: [makeElement('note-1')],
                deletes: [],
            });

        const mutationResponse = await request(harness.app)
            .post(`/boards/${BOARD_ID}/mutations`)
            .send({
                mutations: [
                    {
                        mutationId: 'mutation-1',
                        boardId: BOARD_ID,
                        clientTimestamp: 1,
                        operation: {
                            type: MutationType.CREATE_ELEMENT,
                            elementId: 'note-1',
                            data: makeElement('note-1'),
                        },
                    },
                ],
            });

        expect(patchResponse.status).toBe(403);
        expect(patchResponse.body.error).toBe('No edit access to this board');
        expect(mutationResponse.status).toBe(403);
        expect(mutationResponse.body.error).toBe('No edit access to this board');
    });

    it('returns 400 for invalid PATCH /boards/:id/elements payloads', async () => {
        const harness = createHarness({});

        const invalidResponses = await Promise.all([
            request(harness.app).patch(`/boards/${BOARD_ID}/elements`).send({ upserts: {}, deletes: [] }),
            request(harness.app).patch(`/boards/${BOARD_ID}/elements`).send({ upserts: [], deletes: [] }),
        ]);

        expect(invalidResponses[0]?.status).toBe(400);
        expect(invalidResponses[0]?.body.error).toMatch(/expected array/i);
        expect(invalidResponses[1]?.status).toBe(400);
        expect(invalidResponses[1]?.body.error).toBe('upserts and deletes must be arrays and at least one change is required');
    });

    it('returns 400 for invalid UUID route params and UUID-backed bodies', async () => {
        const harness = createHarness({});

        const invalidResponses = await Promise.all([
            request(harness.app).patch(`/boards/${INVALID_UUID}/elements`).send({
                upserts: [makeElement('note-1')],
                deletes: [],
            }),
            request(harness.app).post(`/boards/${BOARD_ID}/members`).send({
                userId: INVALID_UUID,
            }),
            request(harness.app).delete(`/boards/${BOARD_ID}/members/${INVALID_UUID}`),
            request(harness.app).get(`/workspaces/${INVALID_UUID}/boards`),
        ]);

        for (const response of invalidResponses) {
            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Invalid UUID');
        }
    });
});
