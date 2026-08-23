import 'dotenv/config';
import type { Server } from 'node:http';
import type Redis from 'ioredis';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { createApp } from '@/app/create-app.js';
import { createAppRuntime } from '@/app/runtime.js';
import { runAppShell } from '@/apps/app-shell.js';
import { JOB_QUEUES, createJobsQueue } from '@/platform/jobs/queues.js';

/**
 * REST API app. Owns HTTP concerns only: routes, rate limiting, health,
 * metrics and the Bull Board dashboard (read-only view over the job queues
 * the worker app processes).
 */
const KEEP_ALIVE_GRACE_MS = 2_000;

const config = loadConfig();
const runtime = createAppRuntime(config);

const app = createApp(runtime, {
    bullBoardQueues: () => [
        createJobsQueue(runtime.jobsRedis, JOB_QUEUES.boardPersistFlush),
        createJobsQueue(runtime.jobsRedis, JOB_QUEUES.boardMaintenance),
    ],
});

let server: Server | undefined;

runAppShell({
    name: 'API',
    start() {
        return new Promise<void>((resolve) => {
            server = app.listen(config.port, () => {
                logger.info({ port: config.port, env: config.nodeEnv }, '[API] Listening');
                resolve();
            });
        });
    },
    async shutdown() {
        await new Promise<void>((resolve) => {
            if (!server) {
                resolve();
                return;
            }
            server.close(() => resolve());
            setTimeout(() => {
                server?.closeAllConnections();
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
