import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { createDb } from '@/platform/db/client.js';
import {
    boards,
    elements,
    users,
    workspaceMembers,
    workspaces,
} from '@/platform/db/schema.js';
import { createAuthService } from '@/modules/auth/index.js';

const BENCH_USER_EMAIL = 'bench@notecanva.dev';
const BENCH_USER_NAME = 'Bench User';
const BENCH_WORKSPACE_NAME = 'Bench Workspace';
const BENCH_BOARD_NAME = 'Bench Board';
const BENCH_ELEMENT_COUNT = 50;
const FIXTURE_OUTPUT_PATH = process.env.BENCH_FIXTURE_OUT ?? '/tmp/bench-fixture.json';

// Element rows mirror persistence-domain.toElementRow: identity/kind/timestamps
// live in columns, everything else rides the jsonb payload.
function benchElementRow(boardId: string, index: number) {
    return {
        id: `bench-note-${index.toString().padStart(3, '0')}`,
        boardId,
        type: 'NOTE',
        data: {
            x: 80 + (index % 10) * 180,
            y: 80 + Math.floor(index / 10) * 140,
            zIndex: index + 1,
        },
    };
}

async function ensureFixture() {
    const config = loadConfig();
    const db = createDb(config.databaseUrl);

    let [user] = await db.select().from(users).where(eq(users.email, BENCH_USER_EMAIL)).limit(1);
    if (!user) {
        [user] = await db.insert(users).values({ email: BENCH_USER_EMAIL, name: BENCH_USER_NAME }).returning();
        logger.info({ userId: user.id }, '[BenchFixture] created user');
    }

    let [workspace] = await db.select().from(workspaces)
        .where(and(eq(workspaces.ownerId, user.id), eq(workspaces.name, BENCH_WORKSPACE_NAME)))
        .limit(1);
    if (!workspace) {
        [workspace] = await db.insert(workspaces).values({
            name: BENCH_WORKSPACE_NAME,
            ownerId: user.id,
        }).returning();
        await db.insert(workspaceMembers).values({
            workspaceId: workspace.id,
            userId: user.id,
            role: 'owner',
        });
        logger.info({ workspaceId: workspace.id }, '[BenchFixture] created workspace');
    }

    let [board] = await db.select().from(boards)
        .where(and(eq(boards.workspaceId, workspace.id), eq(boards.name, BENCH_BOARD_NAME)))
        .limit(1);
    if (!board) {
        [board] = await db.insert(boards).values({
            workspaceId: workspace.id,
            name: BENCH_BOARD_NAME,
        }).returning();
        logger.info({ boardId: board.id }, '[BenchFixture] created board');
    }

    const existingElements = await db.select({ id: elements.id })
        .from(elements)
        .where(eq(elements.boardId, board.id));
    if (existingElements.length < BENCH_ELEMENT_COUNT) {
        await db.insert(elements).values(
            Array.from({ length: BENCH_ELEMENT_COUNT }, (_, index) => benchElementRow(board.id, index)),
        ).onConflictDoNothing();
        logger.info({ count: BENCH_ELEMENT_COUNT }, '[BenchFixture] seeded elements');
    }

    const authService = createAuthService(config);
    const fixture = {
        baseUrl: process.env.BENCH_API_URL ?? `http://localhost:${config.port}`,
        realtimeUrl: process.env.BENCH_REALTIME_URL ?? 'http://localhost:3001',
        accessToken: authService.generateAccessToken(user.id),
        boardId: board.id,
        elementIds: Array.from(
            { length: BENCH_ELEMENT_COUNT },
            (_, index) => benchElementRow(board.id, index).id,
        ),
        apiPathPrefix: '/api/v1',
    };

    // 0o600: the fixture embeds a live access token; never world-readable.
    await writeFile(FIXTURE_OUTPUT_PATH, JSON.stringify(fixture, null, 2), { mode: 0o600 });
    logger.info({ path: FIXTURE_OUTPUT_PATH }, '[BenchFixture] fixture ready');
}

ensureFixture().catch((err) => {
    logger.error({ err }, '[BenchFixture] failed');
    process.exit(1);
});
