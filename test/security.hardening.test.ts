import express from 'express';
import request from 'supertest';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createAuthService } from '@/modules/auth/auth.service.js';
import { createBoardMutationLockDomain } from '@/modules/collaboration/board-state/mutation-lock-domain.js';
import { BOARD_MUTATION_LOCK_TTL_MS, boardMutationLockKey } from '@/modules/collaboration/board-state/keys.js';
import { accessTokenCookieName } from '@/modules/auth/routes/helpers.js';
import { loadConfig } from '@/shared/config.js';

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';

const config = loadConfig();
const authService = createAuthService(config);

describe('jwt alg pinning', () => {
    it('rejects alg=none forgeries', () => {
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
        expect(() => authService.verifyAccessToken(`${header}.${payload}.`)).toThrow();
    });

    it('rejects HS256 tokens signed with the wrong key', () => {
        const other = createAuthService({ ...config, jwtSecret: 'wrong-secret-wrong-secret-123' });
        const forged = other.generateAccessToken('user-1');
        expect(() => authService.verifyAccessToken(forged)).toThrow();
    });

    it('accepts legitimately signed tokens', () => {
        const token = authService.generateAccessToken('user-1');
        expect(authService.verifyAccessToken(token).sub).toBe('user-1');
    });
});

describe('refresh token comparison', () => {
    it('matches exact tokens and rejects others', () => {
        const raw = authService.generateRefreshToken();
        const hash = authService.hashRefreshToken(raw);
        expect(authService.verifyRefreshToken(raw, hash)).toBe(true);
        expect(authService.verifyRefreshToken(`${raw}0`, hash)).toBe(false);
        expect(authService.verifyRefreshToken(raw, authService.hashRefreshToken('other'))).toBe(false);
    });
});

describe('access token cookie name', () => {
    it('uses the __Host- prefix only in production', () => {
        expect(accessTokenCookieName({ nodeEnv: 'production' })).toBe('__Host-accessToken');
        expect(accessTokenCookieName({ nodeEnv: 'development' })).toBe('accessToken');
        expect(accessTokenCookieName({ nodeEnv: 'test' })).toBe('accessToken');
    });
});

describe('mutation lock acquisition timeout', () => {
    it('fails fast with 503 when the lock is held beyond 2s', async () => {
        const redis = new Redis(REDIS_URL);
        const lock = createBoardMutationLockDomain(redis);
        const boardId = `lock-test-${Date.now()}`;

        // Simulate a partitioned/held lock from another writer.
        await redis.set(boardMutationLockKey(boardId), 'held', 'PX', 60_000);

        const startedAt = Date.now();
        await expect(lock.withBoardMutationLock(boardId, async () => 'never')).rejects.toMatchObject({
            status: 503,
        });
        const waited = Date.now() - startedAt;
        expect(waited).toBeGreaterThanOrEqual(1_500);
        expect(waited).toBeLessThan(4_000);

        expect(await redis.del(boardMutationLockKey(boardId))).toBe(1);
        await redis.quit();
    }, 15_000);

    it('runs the task when the lock is free and releases afterwards', async () => {
        const redis = new Redis(REDIS_URL);
        const lock = createBoardMutationLockDomain(redis);
        const boardId = `lock-free-${Date.now()}`;

        const result = await lock.withBoardMutationLock(boardId, async () => 'ran');
        expect(result).toBe('ran');
        expect(await redis.ttl(boardMutationLockKey(boardId))).toBe(-2);

        expect(BOARD_MUTATION_LOCK_TTL_MS).toBeGreaterThan(0);
        await redis.quit();
    });
});
