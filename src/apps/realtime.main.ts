import 'dotenv/config';
import http from 'node:http';
import type { Request, Response } from 'express';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { createSocketIoRealtimeServer } from '@/modules/realtime/index.js';
import { createAppRuntime } from '@/app/runtime.js';
import { runAppShell } from '@/apps/app-shell.js';

/**
 * Realtime app. Owns Socket.IO: CRDT sessions, presence, mutation batches.
 * Scales horizontally via the socket.io redis adapter + redis-backed
 * participants store; put a sticky-session proxy in front when running
 * more than one replica.
 */
const REALTIME_DEFAULT_PORT = 3001;
const KEEP_ALIVE_GRACE_MS = 2_000;

const config = loadConfig();
const realtimePort = Number(process.env.REALTIME_PORT ?? REALTIME_DEFAULT_PORT);
const runtime = createAppRuntime(config);

const server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
        void runtime.metrics.getPromRegistry().metrics().then((body) => {
            res.setHeader('Content-Type', runtime.metrics.getPromRegistry().contentType);
            res.end(body);
        }, () => {
            res.statusCode = 500;
            res.end('metrics collection failed');
        });
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: 'realtime' }));
});

runAppShell({
    name: 'Realtime',
    start() {
        return new Promise<void>((resolve) => {
            server.listen(realtimePort, () => {
                logger.info({ port: realtimePort, env: config.nodeEnv }, '[Realtime] Listening');

                createSocketIoRealtimeServer(server, {
                    authService: runtime.authService,
                    userService: runtime.userService,
                    boardService: runtime.boardService,
                    boardStateService: runtime.boardStateService,
                    mutationProcessor: runtime.mutationProcessor,
                    events: runtime.events,
                    pubRedis: runtime.pubRedis,
                    subRedis: runtime.subRedis,
                }, {
                    corsOrigin: config.corsOrigin,
                });

                resolve();
            });
        });
    },
    async shutdown() {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            setTimeout(() => {
                server.closeAllConnections();
            }, KEEP_ALIVE_GRACE_MS).unref();
        });

        await Promise.allSettled([
            runtime.redis.quit(),
            runtime.pubRedis.quit(),
            runtime.subRedis.quit(),
            runtime.jobsRedis.quit(),
            runtime.db.$client.end(),
        ]);
    },
});
