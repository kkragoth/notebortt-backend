import 'dotenv/config';
import http from 'node:http';
import { loadConfig } from '@/shared/config.js';
import { createSocketIoRealtimeServer } from '@/modules/realtime/index.js';
import { createAppRuntime } from '@/app/runtime.js';
import { logger } from '@/shared/logger.js';

/**
 * Realtime app. Owns Socket.IO: CRDT sessions, presence, mutation batches.
 * Scales horizontally via the socket.io redis adapter + redis-backed
 * participants store; put a sticky-session proxy in front when running
 * more than one replica.
 */
const REALTIME_DEFAULT_PORT = 3001;

const config = loadConfig();
const realtimePort = Number(process.env.REALTIME_PORT ?? REALTIME_DEFAULT_PORT);
const runtime = createAppRuntime(config);

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: 'realtime' }));
});

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
});

const SHUTDOWN_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_GRACE_MS = 2_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info({ signal }, '[Realtime] Shutting down');

    const forceExitTimer = setTimeout(() => {
        logger.error('[Realtime] Forced exit: graceful shutdown timed out');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
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

        clearTimeout(forceExitTimer);
        logger.info('[Realtime] Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, '[Realtime] Shutdown failed');
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
