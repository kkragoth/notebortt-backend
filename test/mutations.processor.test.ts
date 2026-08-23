import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Mutation } from '@/modules/collaboration/mutations/types.js';
import { createDb } from '@/platform/db/client.js';
import { createRedisClient } from '@/platform/redis/client.js';
import { createBoardStateService } from '@/modules/collaboration/board-state.service.js';
import { createMutationProcessor } from '@/modules/collaboration/mutations/processor.js';
import { MutationType } from '@/modules/collaboration/mutations/types.js';
import { boards, elements, users, workspaces } from '@/platform/db/schema.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://notecanva:localdev@localhost:5432/notecanva';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const db = createDb(DATABASE_URL);
const redis = createRedisClient(REDIS_URL);
const secondRedis = createRedisClient(REDIS_URL);
const boardStateService = createBoardStateService(redis, db);
const secondBoardStateService = createBoardStateService(secondRedis, db);
const mutationProcessor = createMutationProcessor(boardStateService);
const competingMutationProcessor = createMutationProcessor(boardStateService);
const distributedMutationProcessor = createMutationProcessor(secondBoardStateService);

let TEST_BOARD_ID: string;
let TEST_USER_ID: string;
let TEST_WORKSPACE_ID: string;

const TEST_USER_EMAIL = `test-mut-processor-${Date.now()}@test.com`;

function makeMutationId(): string {
    return crypto.randomUUID();
}

function makeElementId(): string {
    return crypto.randomUUID();
}

function makeCreateMutation(elementId: string, overrides: Partial<Mutation> = {}): Mutation {
    return {
        mutationId: makeMutationId(),
        boardId: TEST_BOARD_ID,
        clientTimestamp: Date.now(),
        operation: {
            type: MutationType.CREATE_ELEMENT,
            elementId,
            data: {
                id: elementId,
                kind: 'NOTE',
                x: 100,
                y: 200,
                zIndex: 1,
                updatedAt: Date.now(),
            },
        },
        ...overrides,
    };
}

function makeCreateElementMutation(elementId: string, kind: string): Mutation {
    return makeCreateMutation(elementId, {
        operation: {
            type: MutationType.CREATE_ELEMENT,
            elementId,
            data: {
                id: elementId,
                kind,
                x: 100,
                y: 200,
                zIndex: 1,
                updatedAt: Date.now(),
            },
        },
    });
}

function makeUpdateMutation(elementId: string, fields: Record<string, unknown>): Mutation {
    return {
        mutationId: makeMutationId(),
        boardId: TEST_BOARD_ID,
        clientTimestamp: Date.now(),
        operation: {
            type: MutationType.UPDATE_ELEMENT,
            elementId,
            fields,
        },
    };
}

function makeMoveMutation(elementId: string, x: number, y: number): Mutation {
    return {
        mutationId: makeMutationId(),
        boardId: TEST_BOARD_ID,
        clientTimestamp: Date.now(),
        operation: {
            type: MutationType.MOVE_ELEMENTS,
            moves: [{ elementId, x, y }],
        },
    };
}

beforeAll(async () => {
    const [user] = await db
        .insert(users)
        .values({ email: TEST_USER_EMAIL, name: 'Test User' })
        .returning();
    TEST_USER_ID = user.id;

    const [workspace] = await db
        .insert(workspaces)
        .values({ name: 'Test Workspace', ownerId: TEST_USER_ID })
        .returning();
    TEST_WORKSPACE_ID = workspace.id;

    const [board] = await db
        .insert(boards)
        .values({ workspaceId: TEST_WORKSPACE_ID, name: 'Test Board' })
        .returning();
    TEST_BOARD_ID = board.id;

    await boardStateService.loadBoard(TEST_BOARD_ID);
});

afterAll(async () => {
    await boardStateService.flushBoard(TEST_BOARD_ID);

    await db.delete(elements).where(eq(elements.boardId, TEST_BOARD_ID));
    await db.delete(boards).where(eq(boards.id, TEST_BOARD_ID));
    await db.delete(workspaces).where(eq(workspaces.id, TEST_WORKSPACE_ID));
    await db.delete(users).where(eq(users.id, TEST_USER_ID));

    await redis.quit();
    await secondRedis.quit();
});

describe('CREATE_ELEMENT', () => {
    it('stores the element in Redis and emits a canonical change', async () => {
        const elementId = makeElementId();
        const mutation = makeCreateMutation(elementId);

        const result = await mutationProcessor.processMutation(mutation, TEST_USER_ID);

        expect(result.status).toBe('applied');
        expect(result.serverTimestamp).toBeTypeOf('number');
        expect(result.sequence).toBeTypeOf('number');

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis).not.toBeNull();
        expect(inRedis?.x).toBe(100);
        expect(inRedis?.y).toBe(200);
        expect(result.change?.upserts).toHaveLength(1);
        expect(result.change?.deletes).toEqual([]);
    });
});

describe('RANGE elements', () => {
    it('creates a RANGE element and persists it to Postgres', async () => {
        const elementId = makeElementId();
        const mutation: Mutation = {
            mutationId: makeMutationId(),
            boardId: TEST_BOARD_ID,
            clientTimestamp: Date.now(),
            operation: {
                type: MutationType.CREATE_ELEMENT,
                elementId,
                data: {
                    id: elementId,
                    kind: 'RANGE',
                    x: 0,
                    y: 0,
                    zIndex: 1,
                    updatedAt: Date.now(),
                    start: '2026-08-10',
                    end: '2026-08-24',
                    color: 'blue',
                    title: 'Sprint planning',
                    calendarId: 'cal-1',
                },
            },
        };

        const result = await mutationProcessor.processMutation(mutation, TEST_USER_ID);
        expect(result.status).toBe('applied');

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis?.kind).toBe('RANGE');
        expect((inRedis as Record<string, unknown>)?.start).toBe('2026-08-10');

        const rows = await db.select().from(elements).where(eq(elements.id, elementId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('RANGE');
        expect((rows[0]?.data as Record<string, unknown>)?.end).toBe('2026-08-24');
    });

    it('updates range dates via UPDATE_ELEMENT', async () => {
        const elementId = makeElementId();
        const mutation = makeCreateElementMutation(elementId, 'RANGE');
        await mutationProcessor.processMutation(mutation, TEST_USER_ID);
        await mutationProcessor.processMutation(
            makeUpdateMutation(elementId, { start: '2026-09-01', end: '2026-09-05' }),
            TEST_USER_ID,
        );

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect((inRedis as Record<string, unknown>)?.start).toBe('2026-09-01');
    });
});

describe('Idempotency', () => {
    it('returns already_applied when same mutationId is processed twice', async () => {
        const elementId = makeElementId();
        const mutation = makeCreateMutation(elementId);

        const first = await mutationProcessor.processMutation(mutation, TEST_USER_ID);
        expect(first.status).toBe('applied');

        const second = await competingMutationProcessor.processMutation(mutation, TEST_USER_ID);
        expect(second.status).toBe('already_applied');
        expect(second.serverTimestamp).toBeUndefined();
    });

    it('applies a concurrent same mutationId request only once', async () => {
        const elementId = makeElementId();
        const mutationId = makeMutationId();
        const mutation = makeCreateMutation(elementId, { mutationId });
        const sequenceBefore = await boardStateService.peekSequence(TEST_BOARD_ID);

        const [first, second] = await Promise.all([
            mutationProcessor.processMutation(mutation, TEST_USER_ID),
            competingMutationProcessor.processMutation(mutation, TEST_USER_ID),
        ]);

        const results = [first, second];
        expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'already_applied')).toHaveLength(1);
        expect(await boardStateService.peekSequence(TEST_BOARD_ID)).toBe(sequenceBefore + 1);
        expect(await boardStateService.getElement(TEST_BOARD_ID, elementId)).not.toBeNull();
    });
});

describe('MOVE_ELEMENTS', () => {
    it('updates x/y in Redis after move', async () => {
        const elementId = makeElementId();
        const createMutation = makeCreateMutation(elementId);
        await mutationProcessor.processMutation(createMutation, TEST_USER_ID);

        const moveMutation: Mutation = {
            mutationId: makeMutationId(),
            boardId: TEST_BOARD_ID,
            clientTimestamp: Date.now(),
            operation: {
                type: MutationType.MOVE_ELEMENTS,
                moves: [{ elementId, x: 500, y: 600 }],
            },
        };

        const result = await mutationProcessor.processMutation(moveMutation, TEST_USER_ID);
        expect(result.status).toBe('applied');

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis?.x).toBe(500);
        expect(inRedis?.y).toBe(600);
    });
});

describe('DELETE_ELEMENTS', () => {
    it('removes the element from Redis after delete', async () => {
        const elementId = makeElementId();
        const createMutation = makeCreateMutation(elementId);
        await mutationProcessor.processMutation(createMutation, TEST_USER_ID);

        const inRedisBefore = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedisBefore).not.toBeNull();

        const deleteMutation: Mutation = {
            mutationId: makeMutationId(),
            boardId: TEST_BOARD_ID,
            clientTimestamp: Date.now(),
            operation: {
                type: MutationType.DELETE_ELEMENTS,
                elementIds: [elementId],
            },
        };

        const result = await mutationProcessor.processMutation(deleteMutation, TEST_USER_ID);
        expect(result.status).toBe('applied');

        const inRedisAfter = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedisAfter).toBeNull();
    });
});

describe('UPDATE_ELEMENT on non-existent element', () => {
    it('does not throw and returns applied', async () => {
        const nonExistentId = makeElementId();
        const updateMutation: Mutation = {
            mutationId: makeMutationId(),
            boardId: TEST_BOARD_ID,
            clientTimestamp: Date.now(),
            operation: {
                type: MutationType.UPDATE_ELEMENT,
                elementId: nonExistentId,
                fields: { x: 999 },
            },
        };

        await expect(mutationProcessor.processMutation(updateMutation, TEST_USER_ID)).resolves.toMatchObject({
            status: 'applied',
        });
    });
});

describe('processBatch', () => {
    it('processes all mutations in order with incrementing sequences', async () => {
        const idA = makeElementId();
        const idB = makeElementId();
        const idC = makeElementId();

        const batch: Mutation[] = [
            makeCreateMutation(idA),
            makeCreateMutation(idB),
            makeCreateMutation(idC),
        ];

        const results = await mutationProcessor.processBatch(batch, TEST_USER_ID);

        expect(results).toHaveLength(3);
        expect(results.every((r) => r.status === 'applied')).toBe(true);

        const sequences = results.map((r) => r.sequence as number);
        expect(sequences[1]).toBe(sequences[0] + 1);
        expect(sequences[2]).toBe(sequences[1] + 1);

        for (const id of [idA, idB, idC]) {
            const inRedis = await boardStateService.getElement(TEST_BOARD_ID, id);
            expect(inRedis).not.toBeNull();
        }
    });

    it('persists once for a multi-mutation solo batch', async () => {
        const idA = makeElementId();
        const idB = makeElementId();
        const idC = makeElementId();
        const persistSpy = vi.spyOn(boardStateService, 'persistBoard');

        const batch: Mutation[] = [
            makeCreateMutation(idA),
            makeCreateMutation(idB),
            makeCreateMutation(idC),
        ];

        await mutationProcessor.processBatch(batch, TEST_USER_ID);

        expect(persistSpy).toHaveBeenCalledTimes(1);
        expect(persistSpy).toHaveBeenCalledWith(TEST_BOARD_ID);
        persistSpy.mockRestore();
    });
});

describe('distributed board locking', () => {
    it('serializes same-board mutations across service instances', async () => {
        const firstElementId = makeElementId();
        const secondElementId = makeElementId();
        let releaseFirstMutation!: () => void;
        let firstMutationEntered = false;

        const firstMutationGate = new Promise<void>((resolve) => {
            releaseFirstMutation = resolve;
        });

        const originalApplyChangeSet = boardStateService.applyChangeSet;
        const applySpy = vi
            .spyOn(boardStateService, 'applyChangeSet')
            .mockImplementation(async (...args) => {
                firstMutationEntered = true;
                await firstMutationGate;
                return originalApplyChangeSet(...args);
            });

        const firstMutation = makeCreateMutation(firstElementId);
        const secondMutation = makeCreateMutation(secondElementId);

        const firstPromise = mutationProcessor.processMutation(firstMutation, TEST_USER_ID);

        while (!firstMutationEntered) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const secondPromise = distributedMutationProcessor.processMutation(secondMutation, TEST_USER_ID);
        const secondStateBeforeRelease = await Promise.race([
            secondPromise.then(() => 'completed'),
            new Promise<'pending'>((resolve) => {
                setTimeout(() => resolve('pending'), 75);
            }),
        ]);

        expect(secondStateBeforeRelease).toBe('pending');

        releaseFirstMutation();

        const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

        expect(firstResult.status).toBe('applied');
        expect(secondResult.status).toBe('applied');
        expect(secondResult.sequence).toBe((firstResult.sequence ?? 0) + 1);
        expect(await secondBoardStateService.getElement(TEST_BOARD_ID, firstElementId)).not.toBeNull();
        expect(await secondBoardStateService.getElement(TEST_BOARD_ID, secondElementId)).not.toBeNull();

        applySpy.mockRestore();
    });
});

describe('lock persistence', () => {
    it('persists locked:true via UPDATE_ELEMENT', async () => {
        const elementId = makeElementId();
        await mutationProcessor.processMutation(makeCreateMutation(elementId), TEST_USER_ID);

        const result = await mutationProcessor.processMutation(makeUpdateMutation(elementId, { locked: true }), TEST_USER_ID);
        expect(result.status).toBe('applied');

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis?.locked).toBe(true);
    });

    it('persists unlocking (locked:false) via UPDATE_ELEMENT', async () => {
        const elementId = makeElementId();
        await mutationProcessor.processMutation(makeCreateMutation(elementId), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(elementId, { locked: true }), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(elementId, { locked: false }), TEST_USER_ID);

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis?.locked).toBe(false);
    });
});

describe('lock enforcement', () => {
    it('rejects MOVE_ELEMENTS on a locked element', async () => {
        const elementId = makeElementId();
        await mutationProcessor.processMutation(makeCreateMutation(elementId), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(elementId, { locked: true }), TEST_USER_ID);

        await mutationProcessor.processMutation(makeMoveMutation(elementId, 999, 888), TEST_USER_ID);

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis?.x).toBe(100);
        expect(inRedis?.y).toBe(200);
        expect(inRedis?.locked).toBe(true);
    });

    it('rejects position-field UPDATE_ELEMENT on a locked element', async () => {
        const elementId = makeElementId();
        await mutationProcessor.processMutation(makeCreateMutation(elementId), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(elementId, { locked: true }), TEST_USER_ID);

        await mutationProcessor.processMutation(
            makeUpdateMutation(elementId, { containerId: 'some-grid', containerColumnId: 'sec', containerOrder: 0 }),
            TEST_USER_ID,
        );

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect(inRedis?.containerId).toBeUndefined();
    });

    it('allows non-position UPDATE_ELEMENT on a locked element', async () => {
        const elementId = makeElementId();
        await mutationProcessor.processMutation(makeCreateMutation(elementId), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(elementId, { locked: true }), TEST_USER_ID);

        await mutationProcessor.processMutation(makeUpdateMutation(elementId, { title: 'Edited' }), TEST_USER_ID);

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, elementId);
        expect((inRedis as Record<string, unknown>)?.title).toBe('Edited');
        expect(inRedis?.locked).toBe(true);
    });

    it('rejects MOVE of an element contained in a locked grid', async () => {
        const gridId = makeElementId();
        const noteId = makeElementId();
        await mutationProcessor.processMutation(makeCreateElementMutation(gridId, 'COLUMN'), TEST_USER_ID);
        await mutationProcessor.processMutation(makeCreateElementMutation(noteId, 'NOTE'), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(noteId, { containerId: gridId, containerColumnId: 'sec', containerOrder: 0 }), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(gridId, { locked: true }), TEST_USER_ID);

        await mutationProcessor.processMutation(makeMoveMutation(noteId, 500, 600), TEST_USER_ID);

        const inRedis = await boardStateService.getElement(TEST_BOARD_ID, noteId);
        expect(inRedis?.containerId).toBe(gridId);
    });

    it('allows adding a new element into a locked meta layout, but rejects dragging it back out', async () => {
        const metaId = makeElementId();
        const gridId = makeElementId();
        await mutationProcessor.processMutation(makeCreateElementMutation(metaId, 'META_COLUMN'), TEST_USER_ID);
        await mutationProcessor.processMutation(makeUpdateMutation(metaId, { locked: true }), TEST_USER_ID);
        await mutationProcessor.processMutation(makeCreateElementMutation(gridId, 'COLUMN'), TEST_USER_ID);

        // Explicit addition into the locked layout is allowed (lock only blocks dragging).
        await mutationProcessor.processMutation(
            makeUpdateMutation(gridId, { metaContainerId: metaId, metaContainerOrder: 0, x: 0, y: 0 }),
            TEST_USER_ID,
        );
        const afterAdd = await boardStateService.getElement(TEST_BOARD_ID, gridId);
        expect(afterAdd?.metaContainerId).toBe(metaId);

        // Dragging it out of the locked layout is rejected.
        await mutationProcessor.processMutation(
            makeUpdateMutation(gridId, { metaContainerId: undefined, metaContainerOrder: undefined, x: 999, y: 999 }),
            TEST_USER_ID,
        );
        const afterRelease = await boardStateService.getElement(TEST_BOARD_ID, gridId);
        expect(afterRelease?.metaContainerId).toBe(metaId);
        expect(afterRelease?.x).toBe(0);
        expect(afterRelease?.y).toBe(0);
    });
});

describe('write mode behavior', () => {
    it('uses solo mode by default and does not retain redis change-log entries', async () => {
        const elementId = makeElementId();
        const mutation = makeCreateMutation(elementId);
        const sequenceBefore = await boardStateService.peekSequence(TEST_BOARD_ID);

        const result = await mutationProcessor.processMutation(mutation, TEST_USER_ID);
        expect(result.status).toBe('applied');
        expect(result.sequence).toBe(sequenceBefore + 1);

        const catchUp = await boardStateService.getChangesAfter(TEST_BOARD_ID, sequenceBefore);
        expect(catchUp.complete).toBe(false);
        expect(catchUp.changes).toEqual([]);
    });

    it('switches to collab mode when two clients are active and keeps catch-up log', async () => {
        const elementId = makeElementId();
        await boardStateService.trackClient(TEST_BOARD_ID, 'collab-user-a', 'conn-a');
        await boardStateService.trackClient(TEST_BOARD_ID, 'collab-user-b', 'conn-b');

        const sequenceBefore = await boardStateService.peekSequence(TEST_BOARD_ID);
        const mutation = makeCreateMutation(elementId);

        const result = await mutationProcessor.processMutation(mutation, TEST_USER_ID);
        expect(result.status).toBe('applied');

        const catchUp = await boardStateService.getChangesAfter(TEST_BOARD_ID, sequenceBefore);
        expect(catchUp.complete).toBe(true);
        expect(catchUp.changes.length).toBeGreaterThan(0);
    });
});
