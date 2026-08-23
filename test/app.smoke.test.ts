import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '@/shared/config.js';
import { createAppRuntime } from '@/app/runtime.js';
import { createApp } from '@/app/create-app.js';

const config = loadConfig();
const runtime = createAppRuntime(config);
const app = createApp(runtime);

afterAll(async () => {
    await Promise.allSettled([
        runtime.redis.quit(),
        runtime.pubRedis.quit(),
        runtime.jobsRedis.quit(),
        runtime.db.$client.end(),
    ]);
});

describe('app smoke: versioning, request ids, health probes', () => {
    it('liveness probe is dependency-free', async () => {
        const res = await request(app).get('/health/live');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('readiness probe checks dependencies', async () => {
        const res = await request(app).get('/health/ready');
        expect([200, 503]).toContain(res.status);
        expect(res.body.postgres).toBeDefined();
    });

    it('serves the API under /api/v1', async () => {
        const res = await request(app).get('/api/v1/users/me');
        expect(res.status).toBe(401);
    });

    it('keeps legacy unversioned paths mounted by default', async () => {
        const res = await request(app).get('/users/me');
        expect(res.status).toBe(401);
    });

    it('echoes a provided x-request-id and generates one when absent', async () => {
        const echoed = await request(app)
            .get('/health/live')
            .set('x-request-id', 'smoke-test-request-id-123');
        expect(echoed.headers['x-request-id']).toBe('smoke-test-request-id-123');

        const generated = await request(app).get('/health/live');
        expect(generated.headers['x-request-id']).toMatch(/^[\w.@-]{8,128}$/);
    });

    it('webhook path stays unversioned for Stripe dashboard compatibility', async () => {
        const res = await request(app)
            .post('/billing/webhook')
            .set('content-type', 'application/json')
            .send('{}');
        // Signature verification fails, but the route itself must exist (not 404).
        expect(res.status).not.toBe(404);
    });
});
