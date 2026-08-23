import Redis from 'ioredis';
import { logger } from '@/shared/logger.js';

export function createRedisClient(redisUrl: string, overrides: Record<string, unknown> = {}): Redis {
    const client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            const delay = Math.min(times * 200, 2000);
            return delay;
        },
        ...overrides,
    });

    client.on('error', (err) => {
        logger.error({ err }, '[Redis] Connection error');
    });

    client.on('connect', () => {
        logger.info('[Redis] Connected');
    });

    return client;
}
