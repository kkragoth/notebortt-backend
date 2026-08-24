import cors from 'cors';

const AllowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const AllowedHeaders = ['Content-Type', 'Authorization'] as const;

export function parseAllowedOrigins(raw: string): string[] {
    return raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

export function createCorsMiddleware(origin: string) {
    const allowedOrigins = parseAllowedOrigins(origin);

    return cors({
        origin: (requestOrigin, callback) => {
            if (!requestOrigin) {
                callback(null, true);
                return;
            }

            if (allowedOrigins.includes(requestOrigin)) {
                callback(null, true);
                return;
            }

            callback(null, false);
        },
        credentials: true,
        methods: [...AllowedMethods],
        allowedHeaders: [...AllowedHeaders],
    });
}
