import 'dotenv/config';
import { loadConfig } from '@/shared/config.js';
import { createApp } from '@/app/create-app.js';
import { createAppRuntime } from '@/app/runtime.js';
import { JOB_QUEUES, createJobsQueue } from '@/platform/jobs/queues.js';
import { logger } from '@/shared/logger.js';

/**
 * REST API app. Owns HTTP concerns only: routes, rate limiting, health,
 * metrics and the Bull Board dashboard (read-only view over the job queues
 * the worker app processes).
 */
const config = loadConfig();
const runtime = createAppRuntime(config);

const app = createApp(runtime, {
    bullBoardQueues: () => [
        createJobsQueue(runtime.jobsRedis, JOB_QUEUES.boardPersistFlush),
        createJobsQueue(runtime.jobsRedis, JOB_QUEUES.boardMaintenance),
    ],
});

const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, '[API] Listening');
});

const SHUTDOWN_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_GRACE_MS = 2_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info({ signal }, '[API] Shutting down');

    const forceExitTimer = setTimeout(() => {
        logger.error('[API] Forced exit: graceful shutdown timed out');
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
        logger.info('[API] Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, '[API] Shutdown failed');
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
