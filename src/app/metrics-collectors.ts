import { sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { Database } from '@/platform/db/client.js';
import type { RuntimeMetrics } from '@/platform/observability/metrics.js';
import { DIRTY_BOARDS_BY_AGE_KEY, DIRTY_BOARDS_KEY } from '@/modules/collaboration/index.js';

const DB_APPLICATION_NAME = 'note-canva-backend';

/**
 * Scrape-time metric samplers. Values are computed when Prometheus scrapes
 * (via metrics.registerCollector), so no background timers are needed and
 * gauges never go stale between scrapes.
 */

export function registerBoardDirtyCollectors(metrics: RuntimeMetrics, redis: () => Redis): void {
    metrics.registerCollector(async () => {
        const client = redis();
        const backlog = await client.scard(DIRTY_BOARDS_KEY);
        metrics.setGauge('board_dirty_backlog', backlog);

        const oldest = await client.zrange(DIRTY_BOARDS_BY_AGE_KEY, 0, 0, 'WITHSCORES');
        const oldestTimestamp = oldest.length >= 2 ? Number(oldest[1]) : NaN;
        const ageSeconds = Number.isFinite(oldestTimestamp) && oldestTimestamp > 0
            ? Math.max(0, (Date.now() - oldestTimestamp) / 1000)
            : 0;
        metrics.setGauge('board_dirty_age_max_seconds', ageSeconds);
    });
}

export function registerQueueCollectors(metrics: RuntimeMetrics, getQueues: () => Queue[]): void {
    metrics.registerCollector(async () => {
        for (const queue of getQueues()) {
            const counts = await queue.getJobCounts('waiting', 'delayed');
            metrics.setGauge('queue_depth', (counts.waiting ?? 0) + (counts.delayed ?? 0), {
                queue: queue.name,
            });

            const oldestJobs = await queue.getJobs(['waiting', 'delayed'], 0, 0, true);
            const oldestTimestamp = oldestJobs[0]?.timestamp;
            metrics.setGauge(
                'queue_oldest_age_seconds',
                typeof oldestTimestamp === 'number'
                    ? Math.max(0, (Date.now() - oldestTimestamp) / 1000)
                    : 0,
                { queue: queue.name },
            );
        }
    });
}

/**
 * DLQ entries are completed on arrival (retention-bounded), so depth is the
 * number of dead letters still inside the retention window — alerting should
 * threshold on this series, tolerating transient spikes during rolling
 * deploys.
 */
export function registerDlqDepthCollector(metrics: RuntimeMetrics, getDlqQueue: () => Queue | undefined): void {
    metrics.registerCollector(async () => {
        const queue = getDlqQueue();
        if (!queue) {
            return;
        }
        const counts = await queue.getJobCounts('waiting', 'completed');
        metrics.setGauge('dlq_depth', (counts.waiting ?? 0) + (counts.completed ?? 0));
    });
}

export function registerDbPoolCollectors(metrics: RuntimeMetrics, db: Database, poolMax: number): void {
    metrics.setGauge('db_pool_max_connections', poolMax);
    metrics.registerCollector(async () => {
        const result: unknown = await db.execute<{ state: string | null; count: number }>(sql`
            select state, count(*)::int as count
            from pg_stat_activity
            where application_name = ${DB_APPLICATION_NAME}
            group by state
        `);
        // postgres-js sessions yield row arrays directly; node-pg wraps them
        // in { rows }. Handle both so the collector survives driver swaps.
        const rows = (Array.isArray(result) ? result : (result as { rows?: unknown }).rows ?? []) as
            Array<{ state: string | null; count: number }>;

        let active = 0;
        let idle = 0;
        for (const row of rows) {
            if (row.state === 'idle') {
                idle += row.count;
            } else if (row.state !== null) {
                active += row.count;
            }
        }
        metrics.setGauge('db_pool_clients_active', active);
        metrics.setGauge('db_pool_clients_idle', idle);
    });
}
