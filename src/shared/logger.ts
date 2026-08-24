import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

// Human-readable pretty logs only for interactive local terminals;
// containers and CI always get raw JSON (parseable by log collectors).
const usePrettyTransport = !isProduction
    && process.env.NODE_ENV !== 'test'
    && process.env.VITEST === undefined
    && process.stdout.isTTY === true;

export const logger = pino({
    level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers.set-cookie',
            '*.authorization',
            '*.cookie'
        ],
        censor: '[redacted]'
    },
    base: undefined,
    ...(usePrettyTransport ? {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                ignore: 'pid,hostname',
            },
        },
    } : {}),
});

export function childLogger(context: Record<string, string>) {
    return logger.child(context);
}
