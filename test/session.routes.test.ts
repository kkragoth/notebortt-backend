import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { AuthRouterDeps } from '@/modules/auth/routes/types.js';
import { loadConfig } from '@/shared/config.js';
import { createAuthService } from '@/modules/auth/auth.service.js';
import { createUserService } from '@/modules/users/index.js';
import { registerSessionRoutes } from '@/modules/auth/routes/session.routes.js';
import { createDb } from '@/platform/db/client.js';
import { refreshTokens, users } from '@/platform/db/schema.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
const authService = createAuthService(config);
const userService = createUserService(db);

function buildApp(deps: AuthRouterDeps) {
    const app = express();
    app.use(express.json());
    // The real app mounts cookieParser globally in create-app.
    app.use(cookieParser());
    registerSessionRoutes(app, deps);
    return app;
}

const app = buildApp({
    config: { ...config, nodeEnv: 'test' },
    oauth2Client: {} as AuthRouterDeps['oauth2Client'],
    authService,
    userService,
    db,
});

// Session routes reject untrusted origins; supertest sends none by default.
function post(path: string) {
    return request(app).post(path).set('Origin', config.corsOrigin.split(',')[0].trim());
}

const deps = { config: { ...config, nodeEnv: 'test' }, authService, userService, db };

async function createTestUser(): Promise<string> {
    const email = `session-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const [user] = await db.insert(users).values({ email, name: 'Session Test' }).returning({ id: users.id });
    return user.id;
}

async function insertToken(userId: string, options: { familyId?: string; revoked?: boolean; expiresInDays?: number } = {}) {
    const rawToken = authService.generateRefreshToken();
    const [row] = await db.insert(refreshTokens).values({
        userId,
        familyId: options.familyId ?? crypto.randomUUID(),
        tokenHash: authService.hashRefreshToken(rawToken),
        expiresAt: new Date(Date.now() + (options.expiresInDays ?? 7) * 24 * 60 * 60 * 1000),
        revokedAt: options.revoked ? new Date() : null,
    }).returning({ id: refreshTokens.id, familyId: refreshTokens.familyId });
    return { row, rawToken };
}

async function familyRows(familyId: string) {
    return db.select().from(refreshTokens).where(eq(refreshTokens.familyId, familyId));
}

let userId: string;

beforeEach(async () => {
    userId = await createTestUser();
});

afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    await db.$client.end();
});

describe('refresh token rotation with reuse detection', () => {
    it('rotates a valid token inside the same family', async () => {
        const { row, rawToken } = await insertToken(userId);

        const res = await post('/refresh').send({ refreshToken: rawToken });

        expect(res.status).toBe(200);
        expect(res.body.refreshToken).not.toBe(rawToken);
        const rows = await familyRows(row.familyId);
        // Old row revoked (kept for detection), new row active.
        expect(rows).toHaveLength(2);
    });

    it('rejects an unknown token without touching other families', async () => {
        const { row } = await insertToken(userId);

        const res = await post('/refresh').send({ refreshToken: 'totally-unknown-token' });

        expect(res.status).toBe(401);
        const rows = await familyRows(row.familyId);
        expect(rows.every((r) => r.revokedAt === null)).toBe(true);
    });

    it('rejects an expired token', async () => {
        const { rawToken } = await insertToken(userId, { expiresInDays: -1 });

        const res = await post('/refresh').send({ refreshToken: rawToken });

        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/expired/i);
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
        const { row, rawToken } = await insertToken(userId);

        const first = await post('/refresh').send({ refreshToken: rawToken });
        expect(first.status).toBe(200);
        const rotatedToken = first.body.refreshToken as string;

        // Attacker replays the ORIGINAL (already rotated) token.
        const replay = await post('/refresh').send({ refreshToken: rawToken });
        expect(replay.status).toBe(401);
        expect(replay.body.error).toMatch(/reuse/i);

        // The legitimate rotated token must now be dead too.
        const victim = await post('/refresh').send({ refreshToken: rotatedToken });
        expect(victim.status).toBe(401);

        const rows = await familyRows(row.familyId);
        expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it('logout revokes the token so later use is rejected', async () => {
        const { row, rawToken } = await insertToken(userId);

        const logout = await post('/logout').send({ refreshToken: rawToken });
        expect(logout.status).toBe(200);

        const reuse = await post('/refresh').send({ refreshToken: rawToken });
        expect(reuse.status).toBe(401);
        expect(reuse.body.error).toMatch(/reuse|invalid/i);

        // Logout keeps the row for audit/reuse detection.
        const rows = await familyRows(row.familyId);
        expect(rows).toHaveLength(1);
        expect(rows[0].revokedAt).not.toBeNull();
    });

    it('a reused-but-revoked-by-logout token does not nuke unrelated families of the same user', async () => {
        const familyA = await insertToken(userId);
        await insertToken(userId); // family B, untouched

        await post('/logout').send({ refreshToken: familyA.rawToken });
        await post('/refresh').send({ refreshToken: familyA.rawToken });

        const rowsA = await familyRows(familyA.row.familyId);
        expect(rowsA.every((r) => r.revokedAt !== null)).toBe(true);
    });
});
