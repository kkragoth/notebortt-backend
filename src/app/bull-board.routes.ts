import { createHash, timingSafeEqual } from 'node:crypto';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import type { Express, Handler, Router } from 'express';
import type { Queue } from 'bullmq';
import type { AppConfig } from '@/shared/config.js';
import { logger } from '@/shared/logger.js';

export const BULL_BOARD_BASE_PATH = '/admin/queues';

export function createBasicAuthGate(username: string, password: string): Handler {
    const expectedUsername = createHash('sha256').update(username).digest();
    const expectedPassword = createHash('sha256').update(password).digest();

    function safeEqual(a: Buffer, b: Buffer): boolean {
        return timingSafeEqual(a, b);
    }

    return (req, res, next) => {
        const header = req.headers.authorization;
        if (!header?.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"');
            res.status(401).send('Authentication required');
            return;
        }

        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator === -1) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"');
            res.status(401).send('Authentication required');
            return;
        }

        const gotUser = createHash('sha256').update(decoded.slice(0, separator)).digest();
        const gotPass = createHash('sha256').update(decoded.slice(separator + 1)).digest();

        if (safeEqual(gotUser, expectedUsername) && safeEqual(gotPass, expectedPassword)) {
            next();
            return;
        }

        logger.warn({ ip: req.ip }, '[BullBoard] rejected credentials');
        res.setHeader('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"');
        res.status(401).send('Authentication required');
    };
}

export function createBullBoardRouter(queues: Queue[]): Router {
    const serverAdapter = new ExpressAdapter();
    createBullBoard({
        queues: queues.map((queue) => new BullMQAdapter(queue)),
        serverAdapter,
    });
    serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);
    return serverAdapter.getRouter();
}

/**
 * Mounts the dashboard with the same auth posture everywhere it is exposed:
 * password → basic-auth gate; production without a password refuses to mount.
 * Only the worker app calls this — queue handles must not leak into api.
 */
export function mountBullBoard(
    app: Express,
    queues: Queue[],
    config: Pick<AppConfig, 'bullBoardUsername' | 'bullBoardPassword' | 'nodeEnv'>,
): void {
    if (config.bullBoardPassword) {
        app.use(
            BULL_BOARD_BASE_PATH,
            createBasicAuthGate(config.bullBoardUsername, config.bullBoardPassword),
            createBullBoardRouter(queues),
        );
        return;
    }
    if (config.nodeEnv === 'production') {
        logger.error('[BullBoard] enabled in production without BULL_BOARD_PASSWORD — refusing to mount');
        return;
    }
    logger.warn('[BullBoard] mounted WITHOUT auth: set BULL_BOARD_PASSWORD to lock it down');
    app.use(BULL_BOARD_BASE_PATH, createBullBoardRouter(queues));
}
