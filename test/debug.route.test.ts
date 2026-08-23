import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDebugRouter } from '@/app/debug.routes.js';

describe('GET /debug/state', () => {
    it('returns 404 in production', async () => {
        const app = express();
        app.use('/debug', createDebugRouter({
            config: { nodeEnv: 'production' } as const,
            db: {} as any,
            redis: {} as any,
            boardStateService: {} as any,
        }));

        const response = await request(app).get('/debug/state');

        expect(response.status).toBe(404);
    });

    it('returns postgres and redis debug payload in development', async () => {
        const app = express();
        let executeCall = 0;
        const db = {
            execute: async () => {
                executeCall += 1;
                if (executeCall === 2) {
                    return [{ id: 'board-1', workspaceId: 'workspace-1', name: 'Board', updatedAt: new Date(), previewUpdatedAt: null }];
                }

                return [{ users: 1, workspaces: 1, boards: 1, elements: 2, mutations: 3 }];
            },
        } as any;

        const redis = {
            info: async () => 'used_memory_human:1.20M\nused_memory_peak_human:1.40M\nmem_fragmentation_ratio:1.01\n',
            dbsize: async () => 12,
            scan: async () => ['0', ['board:board-1:seq', 'board:board-1:elements']],
            get: async (key: string) => key.endsWith(':seq') ? '4' : key.endsWith(':last_active') ? '123456' : null,
            scard: async () => 2,
            hlen: async () => 8,
        } as any;

        app.use('/debug', createDebugRouter({
            config: { nodeEnv: 'development' } as const,
            db,
            redis,
            boardStateService: {
                getBoardMetrics: async () => ({
                    sequence: 4,
                    lastFlushedSequence: 4,
                    dirtySince: null,
                    dirtyAgeMs: 0,
                    lastFlushDurationMs: null,
                    lastFlushedAt: null,
                }),
            } as any,
        }));

        const response = await request(app).get('/debug/state?boardId=board-1');

        expect(response.status).toBe(200);
        expect(response.body.postgres.counts.boards).toBe(1);
        expect(response.body.redis.boardState.sequence).toBe('4');
        expect(response.body.redis.sampledKeys).toContain('board:board-1:seq');
    });
});
