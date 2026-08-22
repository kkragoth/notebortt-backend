import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '@/lib/logger.js';

export class AppError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'AppError';
        this.status = status;
    }
}

function resolveStatus(err: unknown): number {
    if (err instanceof AppError) {
        return err.status;
    }

    const candidate = err as { status?: unknown; statusCode?: unknown } | null;
    if (candidate && typeof candidate === 'object') {
        if (typeof candidate.status === 'number' && candidate.status >= 400 && candidate.status <= 599) {
            return candidate.status;
        }
        if (typeof candidate.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode <= 599) {
            return candidate.statusCode;
        }
    }

    return 500;
}

export const jsonNotFoundHandler: RequestHandler = (req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    const status = resolveStatus(err);
    const payload = { method: req.method, url: req.originalUrl };

    if (res.headersSent) {
        next(err);
        return;
    }

    if (status >= 500) {
        logger.error({ err, ...payload }, 'unhandled_request_error');
        res.status(status).json({ error: 'Internal server error' });
        return;
    }

    const message = err instanceof Error ? err.message : 'Request failed';
    logger.warn({ err, ...payload }, 'request_error');
    res.status(status).json({ error: message });
};
