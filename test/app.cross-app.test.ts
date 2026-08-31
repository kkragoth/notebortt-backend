import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { closeFixtures, fixturesDb, purgeFixtures } from './helpers/fixtures.js';
import type { Express } from 'express';
import type { AppConfig } from '@/shared/config.js';
import type { AppRuntime } from '@/app/runtime.js';
import { loadConfig } from '@/shared/config.js';
import { createAppRuntime } from '@/app/runtime.js';
import { createApp } from '@/app/create-app.js';
import { APP_EVENTS } from '@/shared/events.js';
import { shutdownInfra } from '@/apps/app-shell.js';
import { boards, users, workspaceMembers, workspaces } from '@/platform/db/schema.js';

/**
 * Cross-app e2e over the production transport shape: a REST mutation on the
 * api app must publish BOARD_MUTATED onto the bullmq transport and end up as
 * a debounced board-preview job for the right board (the worker-side handler
 * is simulated exactly as worker.main wires it).
 */

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const PREFIX = `bull:cross-app-test:${RUN_ID}`;

const originalEnv = {
    EVENT_BUS_TRANSPORT: process.env.EVENT_BUS_TRANSPORT,
    QUEUE_REDIS_PREFIX: process.env.QUEUE_REDIS_PREFIX,
    RATE_LIMIT_DISABLED: process.env.RATE_LIMIT_DISABLED,
};

let config: AppConfig;
let runtime: AppRuntime;
let app: Express;

async function seedBoardAccess(): Promise<{ userId: string; boardId: string }> {
    const db = fixturesDb();
    const [user] = await db.insert(users).values({
        email: `cross-app-${RUN_ID}@example.com`,
        name: 'Cross App Test',
    }).returning({ id: users.id });
    const [workspace] = await db.insert(workspaces).values({
        name: 'cross-app-test',
        ownerId: user.id,
    }).returning({ id: workspaces.id });
    await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
        addedBy: user.id,
    });
    const [board] = await db.insert(boards).values({
        workspaceId: workspace.id,
        name: 'cross-app-board',
    }).returning({ id: boards.id });
    return { userId: user.id, boardId: board.id };
}

beforeAll(async () => {
    process.env.EVENT_BUS_TRANSPORT = 'bullmq';
    process.env.QUEUE_REDIS_PREFIX = PREFIX;
    process.env.RATE_LIMIT_DISABLED = 'true';

    config = loadConfig();
    runtime = createAppRuntime(config, { app: 'api' });
    app = createApp(runtime);
});

afterAll(async () => {
    await purgeFixtures();
    await closeFixtures();
    if (runtime) {
        await runtime.events.close();
        const cleanerKeys = await runtime.jobsRedis.keys(`${PREFIX}:*`);
        if (cleanerKeys.length > 0) {
            await runtime.jobsRedis.del(...cleanerKeys);
        }
        await shutdownInfra(runtime);
    }
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

describe('cross-app REST mutation to preview job', () => {
    it('publishes BOARD_MUTATED from the api app into a board-preview job', async () => {
        const { userId, boardId } = await seedBoardAccess();
        const token = runtime.authService.generateAccessToken(userId);

        // Worker-side wiring replica (worker.main.ts): react to the domain
        // event by enqueueing the debounced preview render.
        const capturedBoardIds: string[] = [];
        const off = runtime.events.on(APP_EVENTS.BOARD_MUTATED, ({ boardId: mutatedBoardId }) => {
            capturedBoardIds.push(mutatedBoardId);
            void runtime.previewJobService.enqueue(mutatedBoardId).catch(() => undefined);
        });

        try {
            const response = await request(app)
                .patch(`/api/v1/boards/${boardId}/elements`)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    upserts: [{
                        id: `el-${RUN_ID}`,
                        kind: 'NOTE',
                        x: 10,
                        y: 20,
                        zIndex: 1,
                        updatedAt: Date.now(),
                    }],
                    deletes: [],
                });

            expect(response.status).toBe(200);
            expect(response.body.ok).toBe(true);

            await vi.waitFor(() => {
                expect(capturedBoardIds).toContain(boardId);
            }, { timeout: 15_000 });

            const previewQueue = runtime.previewJobService.getQueue();
            await vi.waitFor(async () => {
                const jobs = await previewQueue.getJobs(['waiting', 'delayed']);
                expect(jobs.some((job) => job.data.boardId === boardId)).toBe(true);
            }, { timeout: 15_000 });
        } finally {
            off();
        }
    });
});
