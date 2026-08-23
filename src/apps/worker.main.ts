import 'dotenv/config';
import { loadConfig } from '@/shared/config.js';
import { createBackgroundJobs } from '@/app/background-jobs.js';
import { createAppRuntime } from '@/app/runtime.js';
import { APP_EVENTS } from '@/shared/events.js';
import { logger } from '@/shared/logger.js';

/**
 * Worker app. Owns all BullMQ processing (repeatable board persistence +
 * cleanup schedules, preview rendering) and consumes cross-process domain
 * events so preview enqueues react to mutations emitted by api/realtime.
 *
 * Requires EVENT_BUS_MODE=stream: the runtime's event bus then publishes and
 * consumes over a Redis Stream instead of in-process callbacks.
 */
const config = loadConfig();
if (!config.eventBusStreamEnabled) {
    logger.warn('[Worker] EVENT_BUS_MODE != "stream": cross-app preview triggers are inactive');
}

const runtime = createAppRuntime(config);

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

const backgroundJobs = createBackgroundJobs(runtime);
const stopPreviewWorker = runtime.previewJobService.startWorker();

void backgroundJobs.start().then(() => {
    logger.info({ env: config.nodeEnv }, '[Worker] Background jobs started');
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    logger.info({ signal }, '[Worker] Shutting down');

    const forceExitTimer = setTimeout(() => {
        logger.error('[Worker] Forced exit: graceful shutdown timed out');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
        await backgroundJobs.stop();
        await stopPreviewWorker();

        await Promise.allSettled([
            runtime.redis.quit(),
            runtime.pubRedis.quit(),
            runtime.subRedis.quit(),
            runtime.jobsRedis.quit(),
            runtime.db.$client.end(),
        ]);

        clearTimeout(forceExitTimer);
        logger.info('[Worker] Shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, '[Worker] Shutdown failed');
        process.exit(1);
    }
}

process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
    void shutdown('SIGINT');
});
