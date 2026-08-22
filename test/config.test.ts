import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@/config.js';

describe('config', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
        process.env.REDIS_REALTIME_URL = 'redis://localhost:6379';
        process.env.REDIS_JOBS_URL = 'redis://localhost:6380';
        process.env.PORT = '3000';
        process.env.NODE_ENV = 'development';
        process.env.CORS_ORIGIN = 'http://localhost:5173';
        process.env.GOOGLE_CLIENT_ID = 'test-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
        process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/auth/callback';
        process.env.JWT_SECRET = 'test-jwt-secret-min16chars';
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('parses valid environment variables', () => {
        const config = loadConfig();
        expect(config.port).toBe(3000);
        expect(config.databaseUrl).toBe('postgres://test:test@localhost:5432/test');
        expect(config.redisRealtimeUrl).toBe('redis://localhost:6379');
        expect(config.redisJobsUrl).toBe('redis://localhost:6380');
        expect(config.corsOrigin).toBe('http://localhost:5173');
    });

    it('falls back to REDIS_URL when split urls are not set', () => {
        delete process.env.REDIS_REALTIME_URL;
        delete process.env.REDIS_JOBS_URL;
        process.env.REDIS_URL = 'redis://localhost:6379';

        const config = loadConfig();
        expect(config.redisRealtimeUrl).toBe('redis://localhost:6379');
        expect(config.redisJobsUrl).toBe('redis://localhost:6379');
    });

    it('throws on missing DATABASE_URL', () => {
        delete process.env.DATABASE_URL;
        expect(() => loadConfig()).toThrow();
    });

    it('defaults PORT to 3000', () => {
        delete process.env.PORT;
        const config = loadConfig();
        expect(config.port).toBe(3000);
    });
});
