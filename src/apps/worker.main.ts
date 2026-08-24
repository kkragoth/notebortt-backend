import 'dotenv/config';
import http from 'node:http';
import { loadConfig } from '@/shared/config.js';
import { createBackgroundJobs } from '@/app/background-jobs.js';
import { createAppRuntime } from '@/app/runtime.js';
import { runAppShell, shutdownInfra } from '@/apps/app-shell.js';
import { APP_EVENTS } from '@/shared/events.js';
import { logger } from '@/shared/logger.js';

/**
 * Worker app. Owns all BullMQ processing (repeatable board persistence +
 * cleanup schedules, preview rendering) and consumes cross-process domain
 * events so preview enqueues react to mutations emitted by api/realtime.
 *
 * Requires EVENT_BUS_MODE=stream: the runtime's event bus then publishes and
 * consumes over a Redis Stream instead of in-process callbacks.
 *
 * Serves a metrics-only HTTP surface (METRICS_PORT, default 3002) so
 * Prometheus can scrape it and compose has a healthcheck target.
 */
const WORKER_METRICS_DEFAULT_PORT = 3002;
const KEEP_ALIVE_GRACE_MS = 2_000;

const config = loadConfig();
if (!config.eventBusStreamEnabled) {
    logger.warn('[Worker] EVENT_BUS_MODE != "stream": cross-app preview triggers are inactive');
}

const runtime = createAppRuntime(config);

const metricsServer = http.createServer((req, res) => {
    if (req.url === '/metrics' || req.url === '/healthz') {
        void runtime.metrics.getPromRegistry().metrics().then((body) => {
            res.setHeader('Content-Type', runtime.metrics.getPromRegistry().contentType);
            res.end(req.url === '/healthz' ? 'ok\n' : body);
        }, () => {
            res.statusCode = 500;
            res.end('metrics collection failed');
        });
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: 'worker' }));
});

const backgroundJobs = createBackgroundJobs(runtime);
let stopPreviewWorker: (() => Promise<void>) | undefined;

runAppShell({
    name: 'Worker',
    async start() {
        runtime.events.on(APP_EVENTS.BOARD_MUTATED, ({ boardId }) => {
            void runtime.previewJobService.enqueue(boardId).catch((error) => {
                logger.error({ err: error, boardId }, '[PreviewJob] enqueue after board.mutated failed');
            });
        });
        runtime.events.on(APP_EVENTS.BOARD_EDITORS_LEFT, ({ boardId }) => {
            void runtime.previewJobService.enqueueFlush(boardId).catch((error) => {
                logger.error({ err: error, boardId }, '[PreviewJob] flush enqueue after board.editorsLeft failed');
            });
        });

        stopPreviewWorker = runtime.previewJobService.startWorker();
        await backgroundJobs.start();

        const metricsPort = Number(process.env.METRICS_PORT ?? WORKER_METRICS_DEFAULT_PORT);
        await new Promise<void>((resolve) => {
            metricsServer.listen(metricsPort, () => {
                logger.info({ port: metricsPort, env: config.nodeEnv }, '[Worker] Metrics listening');
                resolve();
            });
        });
        logger.info({ env: config.nodeEnv }, '[Worker] Background jobs started');
    },
    async shutdown() {
        await backgroundJobs.stop();
        await stopPreviewWorker?.();

        await new Promise<void>((resolve) => {
            metricsServer.close(() => resolve());
            setTimeout(() => {
                metricsServer.closeAllConnections();
            }, KEEP_ALIVE_GRACE_MS).unref();
        });

        await shutdownInfra(runtime);
    },
});
