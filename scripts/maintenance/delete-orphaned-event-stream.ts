import 'dotenv/config';
import Redis from 'ioredis';

/**
 * One-time maintenance for the P2a event-transport migration: removes the
 * Redis Stream keys and consumer groups left behind by the deleted stream
 * bus (`src/shared/events.ts` pre-rewrite). Safe to run repeatedly; run once
 * per environment after all apps are on EVENT_BUS_TRANSPORT=bullmq.
 *
 * The old bus published on the realtime redis connection under `events:app`.
 */
const ORPHANED_STREAM_KEY = 'events:app';
const ORPHANED_CONSUMER_GROUP = 'app-events';

const redisUrl = process.env.REDIS_REALTIME_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl);

try {
    try {
        await redis.xgroup('DESTROY', ORPHANED_STREAM_KEY, ORPHANED_CONSUMER_GROUP);
        console.log(`destroyed consumer group ${ORPHANED_CONSUMER_GROUP} on ${ORPHANED_STREAM_KEY}`);
    } catch (error) {
        if (!(error instanceof Error && error.message.includes('NOGROUP'))) {
            throw error;
        }
        console.log(`no consumer group ${ORPHANED_CONSUMER_GROUP} on ${ORPHANED_STREAM_KEY}`);
    }

    const removed = await redis.del(ORPHANED_STREAM_KEY);
    console.log(`${removed > 0 ? 'deleted' : 'no'} stream key ${ORPHANED_STREAM_KEY}`);

    // Sweep any test-namespaced leftovers from the old suite key pattern.
    const stale = await redis.keys(`${ORPHANED_STREAM_KEY}:test:*`);
    for (const key of stale) {
        await redis.del(key);
    }
    console.log(`deleted ${stale.length} stale test stream key(s)`);
} finally {
    redis.disconnect();
}
