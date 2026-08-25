import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { loadConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';
import { setupTracing } from '@/platform/observability/tracing.js';
import { createBackgroundJobs } from '@/app/background-jobs.js';
import {
    registerBoardDirtyCollectors,
    registerDlqDepthCollector,
    registerQueueCollectors,
} from '@/app/metrics-collectors.js';
import { mountBullBoard } from '@/app/bull-board.routes.js';
import { createAppRuntime } from '@/app/runtime.js';
import { runAppShell, shutdownInfra } from '@/apps/app-shell.js';
import { APP_EVENTS } from '@/shared/events.js';

/**
 * Worker app. Owns all BullMQ processing (repeatable board persistence +
 * cleanup schedules, preview rendering) and consumes the cross-app domain
 * event queues so preview enqueues react to mutations emitted by
 * api/realtime. The Bull Board dashboard lives here too — this is the only
 * app allowed to open handles to worker-owned queues.
 *
 * Requires EVENT_BUS_TRANSPORT=bullmq: the runtime's event bus then emits
 * and consumes over dedicated queues instead of in-process callbacks.
 *
 * Serves a metrics-only HTTP surface (METRICS_PORT, default 3002) so
 * Prometheus can scrape it and compose has a healthcheck target; Bull Board
 * rides the same surface at /admin/queues when enabled.
 */
const WORKER_METRICS_DEFAULT_PORT = 3002;
const KEEP_ALIVE_GRACE_MS = 2_000;

const tracing = await setupTracing('worker');
const config = loadConfig();
if (config.eventBusTransport !== 'bullmq') {
    logger.warn('[Worker] EVENT_BUS_TRANSPORT != "bullmq": cross-app preview triggers are inactive');
}

const runtime = createAppRuntime(config, { app: 'worker' });

const backgroundJobs = createBackgroundJobs(runtime);

registerBoardDirtyCollectors(runtime.metrics, () => runtime.redis);
registerQueueCollectors(runtime.metrics, () => [
    runtime.previewJobService.getQueue(),
    ...backgroundJobs.getQueues(),
    ...Object.values(runtime.eventQueues ?? {}),
]);
registerDlqDepthCollector(runtime.metrics, () => runtime.eventQueues?.dlq);

const metricsApp = express();
metricsApp.disable('x-powered-by');
metricsApp.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok\n');
});
metricsApp.get('/metrics', async (_req, res) => {
    try {
        const { contentType, body } = await runtime.metrics.scrape();
        res.setHeader('Content-Type', contentType);
        res.send(body);
    } catch {
        res.statusCode = 500;
        res.send('metrics collection failed');
    }
});

const metricsServer = http.createServer(metricsApp);

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

        // Mounted after the queues exist; express accepts late routes until
        // the server starts listening below.
        if (config.enableBullBoard) {
            mountBullBoard(metricsApp, [
                runtime.previewJobService.getQueue(),
                ...backgroundJobs.getQueues(),
                ...Object.values(runtime.eventQueues ?? {}),
            ], config);
        }

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
        await runtime.events.close();

        await new Promise<void>((resolve) => {
            metricsServer.close(() => resolve());
            setTimeout(() => {
                metricsServer.closeAllConnections();
            }, KEEP_ALIVE_GRACE_MS).unref();
        });

        await shutdownInfra(runtime);
        await tracing.shutdown();
    },
});
