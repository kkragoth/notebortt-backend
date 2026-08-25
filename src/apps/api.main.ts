import 'dotenv/config';
import type { Server } from 'node:http';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { setupTracing } from '@/platform/observability/tracing.js';
import { createApp } from '@/app/create-app.js';
import {
    registerBoardDirtyCollectors,
    registerDbPoolCollectors,
    registerQueueCollectors,
} from '@/app/metrics-collectors.js';
import { createAppRuntime } from '@/app/runtime.js';
import { runAppShell, shutdownInfra } from '@/apps/app-shell.js';

/**
 * REST API app. Owns HTTP concerns only: routes, rate limiting, health and
 * metrics. Bull Board lives on the worker app — the api never opens handles
 * to worker-owned queues.
 */
const KEEP_ALIVE_GRACE_MS = 2_000;

const tracing = await setupTracing('api');
const config = loadConfig();
const runtime = createAppRuntime(config, { app: 'api' });

registerBoardDirtyCollectors(runtime.metrics, () => runtime.redis);
registerQueueCollectors(runtime.metrics, () => [...Object.values(runtime.eventQueues ?? {})]);
registerDbPoolCollectors(runtime.metrics, runtime.db, config.dbPoolMax);

const app = createApp(runtime);

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

        await runtime.events.close();
        await tracing.shutdown();
        await shutdownInfra(runtime);
    },
});
