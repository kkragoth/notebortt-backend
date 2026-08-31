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
    // xgroup DESTROY resolves 0 when the key exists but the group does not
    // (and throws NOGROUP when the key itself is gone) — report both honestly.
    const destroyed = await redis.xgroup('DESTROY', ORPHANED_STREAM_KEY, ORPHANED_CONSUMER_GROUP);
    console.log(destroyed === 1
        ? `destroyed consumer group ${ORPHANED_CONSUMER_GROUP} on ${ORPHANED_STREAM_KEY}`
        : `no consumer group ${ORPHANED_CONSUMER_GROUP} on ${ORPHANED_STREAM_KEY}`);

    const removed = await redis.del(ORPHANED_STREAM_KEY);
    console.log(`${removed > 0 ? 'deleted' : 'no'} stream key ${ORPHANED_STREAM_KEY}`);

    // Sweep any test-namespaced leftovers from the old suite key pattern.
    let stale: string[] = [];
    let cursor = '0';
    do {
        const [nextCursor, found] = await redis.scan(cursor, 'MATCH', `${ORPHANED_STREAM_KEY}:test:*`, 'COUNT', 100);
        cursor = nextCursor;
        stale = [...stale, ...found];
    } while (cursor !== '0');
    if (stale.length > 0) {
        await redis.del(...stale);
    }
    console.log(`deleted ${stale.length} stale test stream key(s)`);
} finally {
    redis.disconnect();
}
