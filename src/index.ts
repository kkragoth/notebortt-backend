import 'dotenv/config';
import { loadConfig } from '@/shared/config.js';
import { createApp } from '@/app/create-app.js';
import { createAppRuntime } from '@/app/runtime.js';
import { createSocketIoRealtimeServer } from '@/modules/realtime/index.js';
import { logger } from '@/shared/logger.js';

const config = loadConfig();
const runtime = createAppRuntime(config);
const app = createApp(runtime);

const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, '[Server] Listening');
});

const io = createSocketIoRealtimeServer(server, {
    authService: runtime.authService,
    userService: runtime.userService,
    boardService: runtime.boardService,
    boardStateService: runtime.boardStateService,
    mutationProcessor: runtime.mutationProcessor,
    pubRedis: runtime.pubRedis,
}, {
    corsOrigin: config.corsOrigin,
});

server.on('upgrade', runtime.upgradeHandler);

runtime.wss.on('connection', (ws, request) => {
    runtime.wsHandler.onConnection(ws, request);
});

const persistenceWorker = runtime.boardPersistenceService.startWorker();
const redisCleanupWorker = runtime.redisCleanupService.startWorker();
const stopPreviewWorker = runtime.previewJobService.startWorker();
runtime.heartbeat.startHeartbeat();

const SHUTDOWN_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_GRACE_MS = 2_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info({ signal }, '[Server] Shutting down');

    const forceExitTimer = setTimeout(() => {
        logger.error('[Server] Forced exit: graceful shutdown timed out');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
        clearInterval(persistenceWorker);
        clearInterval(redisCleanupWorker);
        await stopPreviewWorker();
        runtime.heartbeat.stopHeartbeat();

        for (const client of runtime.wss.clients) {
            client.terminate();
        }
        await new Promise<void>((resolve) => {
            runtime.wss.close(() => resolve());
        });

        io.close();
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            setTimeout(() => {
                server.closeAllConnections();
            }, KEEP_ALIVE_GRACE_MS).unref();
        });

        await Promise.allSettled([
            runtime.redis.quit(),
            runtime.pubRedis.quit(),
            runtime.jobsRedis.quit(),
            runtime.db.$client.end(),
        ]);

        clearTimeout(forceExitTimer);
        logger.info('[Server] Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, '[Server] Shutdown failed');
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});

export { app, server, persistenceWorker, redisCleanupWorker, stopPreviewWorker };
export { io };
export const { db, redis } = runtime;
