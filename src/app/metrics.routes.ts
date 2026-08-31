import type { Handler } from 'express';
import type { RuntimeMetrics } from '@/platform/observability/metrics.js';

export function createMetricsRoute(metrics: RuntimeMetrics): Handler {
    return async (_req, res) => {
        try {
            const { contentType, body } = await metrics.scrape();
            res.setHeader('Content-Type', contentType);
            res.send(body);
        } catch (err) {
            res.status(500).json({ error: 'Failed to collect metrics' });
        }
    };
}
