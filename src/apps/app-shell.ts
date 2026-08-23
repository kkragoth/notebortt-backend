import { logger } from '@/shared/logger.js';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface AppShellOptions {
    /** Human-readable service name used in logs. */
    name: string
    start: () => void | Promise<void>
    shutdown: () => Promise<void>
    timeoutMs?: number
}

/**
 * Uniform process lifecycle for the split apps: runs start(), wires
 * SIGTERM/SIGINT to a single-flight graceful shutdown with a force-exit
 * timer, and fails fast if startup itself throws.
 */
export function runAppShell(options: AppShellOptions): void {
    const { name, start, shutdown } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    let shuttingDown = false;

    async function handleSignal(signal: string): Promise<void> {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        logger.info({ signal }, `[${name}] Shutting down`);

        const forceExitTimer = setTimeout(() => {
            logger.error(`[${name}] Forced exit: graceful shutdown timed out`);
            process.exit(1);
        }, timeoutMs);
        forceExitTimer.unref();

        try {
            await shutdown();
            clearTimeout(forceExitTimer);
            logger.info(`[${name}] Shutdown complete`);
            process.exit(0);
        } catch (err) {
            logger.error({ err }, `[${name}] Shutdown failed`);
            process.exit(1);
        }
    }

    process.on('SIGTERM', () => {
        void handleSignal('SIGTERM');
    });
    process.on('SIGINT', () => {
        void handleSignal('SIGINT');
    });

    void Promise.resolve()
        .then(start)
        .catch((err) => {
            logger.error({ err }, `[${name}] Startup failed`);
            process.exit(1);
        });
}
