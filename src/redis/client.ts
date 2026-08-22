import Redis from 'ioredis';
import { logger } from '@/lib/logger.js';

export function createRedisClient(redisUrl: string): Redis {
    const client = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            const delay = Math.min(times * 200, 2000);
            return delay;
        },
    });

    client.on('error', (err) => {
        logger.error({ err }, '[Redis] Connection error');
    });

    client.on('connect', () => {
        logger.info('[Redis] Connected');
    });

    return client;
}
