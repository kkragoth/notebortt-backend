import { describe, expect, it } from 'vitest';
import { KNOWN_QUEUES, createRuntimeMetrics } from '@/platform/observability/metrics.js';

describe('metrics exporter', () => {
    it('exposes pre-registered queue depth/age series for every known queue plus the DLQ', async () => {
        const metrics = createRuntimeMetrics();
        const { body } = await metrics.scrape();

        for (const queue of KNOWN_QUEUES) {
            expect(body).toContain(`queue_depth{queue="${queue}"}`);
            expect(body).toContain(`queue_oldest_age_seconds{queue="${queue}"}`);
        }
        expect(body).toContain('dlq_depth 0');
    });

    it('drops unknown metric names instead of registering them dynamically', async () => {
        const metrics = createRuntimeMetrics();
        // Intentional misuse: a name outside the catalog must never reach
        // the registry, otherwise scrapes gain unbounded series again.
        metrics.incrementCounter('totally_new_metric' as never, 1);

        const { body } = await metrics.scrape();
        expect(body).not.toContain('totally_new_metric');
    });

    it('strips undeclared labels such as boardId from counter samples', async () => {
        const metrics = createRuntimeMetrics();
        metrics.incrementCounter('flush_rows_persisted_total', 3);
        metrics.incrementCounter('redis_commands_total', 1, {
            category: 'state',
            command: 'hmget',
            boardId: '9f8b3c1e-0000-4000-8000-000000000001',
        });

        const { body } = await metrics.scrape();
        expect(body).toContain('redis_commands_total{category="state",command="hmget"} 1');
        expect(body).not.toContain('boardId');
        expect(body).not.toContain('9f8b3c1e');
        expect(body).toContain('flush_rows_persisted_total 3');
    });

    it('drops updates with a missing declared label instead of registering an unlabeled series', async () => {
        const metrics = createRuntimeMetrics();
        // bullmq_jobs_failed_total declares { queue }; omitting it must not
        // produce a phantom unlabeled aggregate next to labeled series.
        metrics.incrementCounter('bullmq_jobs_failed_total', 5);
        metrics.incrementCounter('bullmq_jobs_failed_total', 2, { queue: 'board-preview' });

        const { body } = await metrics.scrape();
        const lines = body.split('\n').filter((line) => line.startsWith('bullmq_jobs_failed_total{'));
        expect(lines).toEqual(['bullmq_jobs_failed_total{queue="board-preview"} 2']);
        expect(body).toContain('bullmq_jobs_failed_total{queue="board-preview"} 2');
    });

    it('records summaries, histograms and gauges through the fixed catalog', async () => {
        const metrics = createRuntimeMetrics();

        metrics.observeTiming('mutation_apply_change_set_duration_ms', 12);
        metrics.observeDuration('mutation_lock_acquisition_duration_seconds', 0.04);
        metrics.observeDuration('socketio_handler_duration_seconds', 0.002, { event: 'board.join' });
        metrics.setGauge('board_dirty_backlog', 7);

        const { body } = await metrics.scrape();
        expect(body).toMatch(/mutation_apply_change_set_duration_ms_sum\b/);
        expect(body).toMatch(/mutation_lock_acquisition_duration_seconds_bucket/);
        expect(body).toMatch(/socketio_handler_duration_seconds_bucket\{[^}]*event="board\.join"/);
        expect(body).toContain('board_dirty_backlog 7');
    });

    it('runs registered collectors once per scrape', async () => {
        const metrics = createRuntimeMetrics();
        let collectorRuns = 0;

        metrics.registerCollector(() => {
            collectorRuns += 1;
            metrics.setGauge('dlq_depth', collectorRuns);
        });

        await metrics.scrape();
        await metrics.scrape();

        expect(collectorRuns).toBe(2);
        const { body } = await metrics.scrape();
        expect(body).toContain('dlq_depth 3');
    });

    it('prefixes default node metrics per app without touching business metric names', async () => {
        const worker = createRuntimeMetrics({ app: 'worker' });
        const api = createRuntimeMetrics({ app: 'api' });
        worker.incrementCounter('bullmq_jobs_failed_total', 1, { queue: 'board-preview' });
        api.incrementCounter('bullmq_jobs_failed_total', 2, { queue: 'board-preview' });

        const [workerBody, apiBody] = await Promise.all([
            worker.scrape().then((r) => r.body),
            api.scrape().then((r) => r.body),
        ]);

        expect(workerBody).toContain('worker_process_resident_memory_bytes');
        expect(apiBody).toContain('api_process_resident_memory_bytes');
        expect(apiBody).not.toContain('worker_nodejs_');
        // Business metrics stay canonical across apps for shared dashboards.
        expect(workerBody).toContain('bullmq_jobs_failed_total{queue="board-preview"} 1');
        expect(apiBody).toContain('bullmq_jobs_failed_total{queue="board-preview"} 2');
    });
});
