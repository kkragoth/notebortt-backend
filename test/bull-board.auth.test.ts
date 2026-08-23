import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBasicAuthGate } from '@/app/bull-board.routes.js';

function buildApp(username: string, password: string) {
    const app = express();
    app.use('/admin/queues', createBasicAuthGate(username, password), (_req, res) => {
        res.status(200).json({ ok: true });
    });
    return app;
}

describe('createBasicAuthGate', () => {
    it('rejects requests without credentials', async () => {
        const res = await request(buildApp('admin', 'secret-pass')).get('/admin/queues');
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toContain('Basic');
    });

    it('rejects wrong credentials', async () => {
        const app = buildApp('admin', 'secret-pass');
        const res = await request(app)
            .get('/admin/queues')
            .set('Authorization', `Basic ${Buffer.from('admin:wrong-pass').toString('base64')}`);
        expect(res.status).toBe(401);
    });

    it('accepts correct credentials', async () => {
        const app = buildApp('admin', 'secret-pass');
        const res = await request(app)
            .get('/admin/queues')
            .set('Authorization', `Basic ${Buffer.from('admin:secret-pass').toString('base64')}`);
        expect(res.status).toBe(200);
    });

    it('rejects malformed authorization headers', async () => {
        const app = buildApp('admin', 'secret-pass');
        const res = await request(app).get('/admin/queues').set('Authorization', 'Bearer whatever');
        expect(res.status).toBe(401);
    });

    it('rejects usernames with embedded colons split incorrectly', async () => {
        const app = buildApp('admin', 'pass:with:colons');
        const good = await request(app)
            .get('/admin/queues')
            .set('Authorization', `Basic ${Buffer.from('admin:pass:with:colons').toString('base64')}`);
        expect(good.status).toBe(200);
    });
});
