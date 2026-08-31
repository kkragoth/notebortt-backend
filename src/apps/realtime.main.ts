import 'dotenv/config';
import http from 'node:http';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { setupTracing } from '@/platform/observability/tracing.js';

/**
 * Realtime app. Owns Socket.IO: CRDT sessions, presence, mutation batches.
 * Scales horizontally via the socket.io redis adapter + redis-backed
 * participants store; put a sticky-session proxy in front when running
 * more than one replica.
 */
const KEEP_ALIVE_GRACE_MS = 2_000;

// Tracing must start before the app graph loads: the OpenTelemetry
// instrumentations hook module loading, so socket.io/ioredis have to be
// imported AFTER sdk.start() or their spans are silently dead.
const tracing = await setupTracing('realtime');
const config = loadConfig();

const [{ createAppRuntime }, { createSocketIoRealtimeServer }, { registerBoardDirtyCollectors, registerQueueCollectors }, { runAppShell, shutdownInfra }] =
    await Promise.all([
        import('@/app/runtime.js'),
        import('@/modules/realtime/index.js'),
        import('@/app/metrics-collectors.js'),
        import('@/apps/app-shell.js'),
    ]);

const realtimePort = config.realtimePort;
const runtime = createAppRuntime(config, { app: 'realtime' });

registerBoardDirtyCollectors(runtime.metrics, () => runtime.redis);
registerQueueCollectors(runtime.metrics, () => [...Object.values(runtime.eventQueues ?? {})]);

const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok\n');
        return;
    }
    if (req.url === '/metrics') {
        try {
            const { contentType, body } = await runtime.metrics.scrape();
            res.setHeader('Content-Type', contentType);
            res.end(body);
        } catch {
            res.statusCode = 500;
            res.end('metrics collection failed');
        }
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
                    metrics: runtime.metrics,
                }, {
                    corsOrigin: config.corsOrigin,
                    activityWriteThrottleMs: config.presenceWriteThrottleMs,
                    activityWriteJitterMs: config.presenceWriteJitterMs,
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

        // Infra teardown first, tracing last (see api.main.ts).
        await shutdownInfra(runtime);
        await runtime.events.close();
        await tracing.shutdown();
    },
});
