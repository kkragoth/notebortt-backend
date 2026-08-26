import 'dotenv/config';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { setupTracing } from '@/platform/observability/tracing.js';

/**
 * REST API app. Owns HTTP concerns only: routes, rate limiting, health and
 * metrics. Bull Board lives on the worker app — the api never opens handles
 * to worker-owned queues.
 */
const KEEP_ALIVE_GRACE_MS = 2_000;

// Tracing must start before the app graph loads: the OpenTelemetry
// instrumentations hook module loading, so express/pg/ioredis have to be
// imported AFTER sdk.start() or their spans are silently dead. Everything
// below is therefore dynamically imported.
const tracing = await setupTracing('api');
const config = loadConfig();

const [{ createAppRuntime }, { createApp }, { registerBoardDirtyCollectors, registerDbPoolCollectors, registerQueueCollectors }, { runAppShell, shutdownInfra }] =
    await Promise.all([
        import('@/app/runtime.js'),
        import('@/app/create-app.js'),
        import('@/app/metrics-collectors.js'),
        import('@/apps/app-shell.js'),
    ]);

const runtime = createAppRuntime(config, { app: 'api' });

registerBoardDirtyCollectors(runtime.metrics, () => runtime.redis);
registerQueueCollectors(runtime.metrics, () => [...Object.values(runtime.eventQueues ?? {})]);
registerDbPoolCollectors(runtime.metrics, runtime.db, config.dbPoolMax);

const app = createApp(runtime);

let server: import('node:http').Server | undefined;

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

        // Infra teardown first, tracing last: spans emitted while Redis/PG
        // drain (and the close operations themselves) must still flush.
        await shutdownInfra(runtime);
        await runtime.events.close();
        await tracing.shutdown();
    },
});
