import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

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
    base: undefined
});

export function childLogger(context: Record<string, string>) {
    return logger.child(context);
}
