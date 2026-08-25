import client from 'prom-client';
import { logger } from '@/shared/logger.js';

/**
 * Fixed, pre-registered Prometheus metrics with static label names.
 *
 * Rules enforced by this module:
 *  - Metric names and label names come exclusively from METRIC_CATALOG;
 *    unknown names are dropped (warn-once), unknown label keys are stripped.
 *  - Label VALUES must stay drawn from bounded code-level enums (command
 *    names, socket event names, queue names). Never add high-cardinality
 *    identifiers such as boardId/userId as labels; quantify those through
 *    aggregates instead.
 */

export type MetricsApp = 'api' | 'realtime' | 'worker'

export interface RuntimeMetricsOptions {
    /** Enables per-app default-metric prefixing (`api_nodejs_*`, ...) and scrape collectors. */
    app?: MetricsApp
}

type MetricSpec =
    | { type: 'counter'; help: string; labelNames?: readonly string[] }
    | { type: 'summary'; help: string }
    | { type: 'histogram'; help: string; buckets: readonly number[]; labelNames?: readonly string[] }
    | { type: 'gauge'; help: string; labelNames?: readonly string[] }

const HISTOGRAM_LOCK_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];
const HISTOGRAM_HANDLER_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1];

// Queues that exist today plus the P2a transport queues; depth/age gauges
// pre-register every entry so dashboards see the full series set from day one.
export const KNOWN_QUEUES = [
    'board-persist-flush',
    'board-maintenance',
    'board-preview',
    'board-mutations',
    'board-control-events',
] as const;

export const METRIC_CATALOG = {
    redis_commands_total: {
        type: 'counter',
        help: 'Redis commands issued, grouped by bounded category and command name',
        labelNames: ['category', 'command'],
    },
    flush_rows_persisted_total: {
        type: 'counter',
        help: 'Element rows upserted/deleted in Postgres by board state flushes',
    },
    legacy_requests_total: {
        type: 'counter',
        help: 'Requests served by the legacy unversioned API routes',
    },
    oauth_fragment_tokens_total: {
        type: 'counter',
        help: 'OAuth callbacks that emitted access/refresh tokens in the redirect fragment',
    },
    bullmq_jobs_failed_total: {
        type: 'counter',
        help: 'BullMQ jobs that exhausted or failed an attempt',
        labelNames: ['queue'],
    },
    domain_events_enqueue_failed_total: {
        type: 'counter',
        help: 'Cross-app domain event enqueues that failed (delivery degraded, primary result unaffected)',
    },
    socketio_client_events_total: {
        type: 'counter',
        help: 'Socket.IO client events received',
        labelNames: ['event'],
    },
    socketio_handler_errors_total: {
        type: 'counter',
        help: 'Socket.IO handler executions that threw',
        labelNames: ['event'],
    },
    socketio_throttled_events_total: {
        type: 'counter',
        help: 'Client events dropped by per-socket rate limiting or byte caps',
        labelNames: ['event'],
    },

    mutation_apply_change_set_duration_ms: {
        type: 'summary',
        help: 'Time to apply one element change set against Redis board state (ms)',
    },
    flush_duration_ms: {
        type: 'summary',
        help: 'Duration of a full dirty-board flush cycle (ms)',
    },
    mutation_process_batch_duration_ms: {
        type: 'summary',
        help: 'Duration of a mutation processBatch call (ms)',
    },

    mutation_lock_acquisition_duration_seconds: {
        type: 'histogram',
        help: 'Time spent acquiring the per-board mutation lock (local queue + Redis SET NX)',
        buckets: HISTOGRAM_LOCK_BUCKETS,
    },
    socketio_handler_duration_seconds: {
        type: 'histogram',
        help: 'Socket.IO handler execution duration',
        buckets: HISTOGRAM_HANDLER_BUCKETS,
        labelNames: ['event'],
    },

    board_dirty_backlog: {
        type: 'gauge',
        help: 'Number of boards waiting for persistence flush',
    },
    board_dirty_age_max_seconds: {
        type: 'gauge',
        help: 'Age of the oldest dirty-board marker in seconds',
    },
    queue_depth: {
        type: 'gauge',
        help: 'Jobs waiting or delayed per queue',
        labelNames: ['queue'],
    },
    queue_oldest_age_seconds: {
        type: 'gauge',
        help: 'Age of the oldest waiting/delayed job per queue',
        labelNames: ['queue'],
    },
    dlq_depth: {
        type: 'gauge',
        help: 'Dead-letter queue depth (populated from P2a onwards)',
    },
    db_pool_clients_active: {
        type: 'gauge',
        help: 'Postgres backends in active (non-idle) state for this application_name',
    },
    db_pool_clients_idle: {
        type: 'gauge',
        help: 'Postgres idle backends for this application_name',
    },
    db_pool_max_connections: {
        type: 'gauge',
        help: 'Configured pool size cap for this application',
    },
    socketio_connected_sockets: {
        type: 'gauge',
        help: 'Currently connected Socket.IO sockets on this replica',
    },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof METRIC_CATALOG
export type MetricLabels = Record<string, string>

export type TimingMetricName = {
    [K in MetricName]: (typeof METRIC_CATALOG)[K]['type'] extends 'summary' ? K : never
}[MetricName]
export type HistogramMetricName = {
    [K in MetricName]: (typeof METRIC_CATALOG)[K]['type'] extends 'histogram' ? K : never
}[MetricName]
export type GaugeMetricName = {
    [K in MetricName]: (typeof METRIC_CATALOG)[K]['type'] extends 'gauge' ? K : never
}[MetricName]

export interface ScrapeResult {
    contentType: string
    body: string
}

export interface RuntimeMetrics {
    incrementCounter: (name: MetricName, value?: number, labels?: MetricLabels) => void
    observeTiming: (name: TimingMetricName, valueMs: number) => void
    observeDuration: (name: HistogramMetricName, seconds: number, labels?: MetricLabels) => void
    setGauge: (name: GaugeMetricName, value: number, labels?: MetricLabels) => void
    logStructured: (event: string, details: Record<string, unknown>) => void
    /** Registers an async sampler executed once per scrape before serialization. */
    registerCollector: (collector: () => Promise<void> | void) => void
    scrape: () => Promise<ScrapeResult>
    getPromRegistry: () => client.Registry
}

type CounterSpec = Extract<MetricSpec, { type: 'counter' }>
type SummarySpec = Extract<MetricSpec, { type: 'summary' }>
type HistogramSpec = Extract<MetricSpec, { type: 'histogram' }>
type GaugeSpec = Extract<MetricSpec, { type: 'gauge' }>

function specFor(name: MetricName): MetricSpec {
    return METRIC_CATALOG[name];
}

function counterSpec(name: MetricName): CounterSpec {
    const spec = specFor(name);
    if (spec.type !== 'counter') {
        throw new Error(`metric ${name} is not a counter`);
    }
    return spec;
}

function histogramSpec(name: MetricName): HistogramSpec {
    const spec = specFor(name);
    if (spec.type !== 'histogram') {
        throw new Error(`metric ${name} is not a histogram`);
    }
    return spec;
}

function gaugeSpec(name: MetricName): GaugeSpec {
    const spec = specFor(name);
    if (spec.type !== 'gauge') {
        throw new Error(`metric ${name} is not a gauge`);
    }
    return spec;
}

export function createRuntimeMetrics(options: RuntimeMetricsOptions = {}): RuntimeMetrics {
    const registry = new client.Registry();

    // Per-app prefix isolates node/process metrics when several app registries
    // are scraped into one Prometheus; business metric names stay canonical.
    if (options.app) {
        client.collectDefaultMetrics({ register: registry, prefix: `${options.app}_` });
    } else if (process.env.NODE_ENV !== 'test') {
        client.collectDefaultMetrics({ register: registry });
    }

    const counters = new Map<string, client.Counter<string>>();
    const summaries = new Map<string, client.Summary<string>>();
    const histograms = new Map<string, client.Histogram<string>>();
    const gauges = new Map<string, client.Gauge<string>>();
    const warnedNames = new Set<string>();

    const collectors: Array<() => Promise<void> | void> = [];

    function warnOnce(message: string): void {
        if (warnedNames.has(message)) {
            return;
        }
        warnedNames.add(message);
        logger.warn(`[Metrics] ${message}`);
    }

    function sanitizeLabels(
        name: MetricName,
        allowed: readonly string[] | undefined,
        labels?: MetricLabels,
    ): Record<string, string> | undefined {
        if (!allowed || allowed.length === 0) {
            if (labels && Object.keys(labels).length > 0) {
                warnOnce(`metric ${name} declares no labels; dropping supplied labels`);
            }
            return undefined;
        }
        const sanitized: Record<string, string> = {};
        for (const key of allowed) {
            const value = labels?.[key];
            if (value === undefined) {
                warnOnce(`metric ${name} missing declared label "${key}"`);
                return undefined;
            }
            sanitized[key] = String(value);
        }
        for (const key of Object.keys(labels ?? {})) {
            if (!allowed.includes(key)) {
                warnOnce(`metric ${name} got undeclared label "${key}"; stripped`);
            }
        }
        return sanitized;
    }

    function promCounter(name: MetricName): client.Counter<string> {
        let counter = counters.get(name);
        if (!counter) {
            counter = new client.Counter({
                name,
                help: counterSpec(name).help,
                labelNames: [...(counterSpec(name).labelNames ?? [])],
                registers: [registry],
            });
            counters.set(name, counter);
        }
        return counter;
    }

    function promSummary(name: MetricName): client.Summary<string> {
        let summary = summaries.get(name);
        if (!summary) {
            summary = new client.Summary({
                name,
                help: (specFor(name) as SummarySpec).help,
                registers: [registry],
            });
            summaries.set(name, summary);
        }
        return summary;
    }

    function promHistogram(name: MetricName): client.Histogram<string> {
        let histogram = histograms.get(name);
        if (!histogram) {
            const spec = histogramSpec(name);
            histogram = new client.Histogram({
                name,
                help: spec.help,
                buckets: [...spec.buckets],
                labelNames: [...(spec.labelNames ?? [])],
                registers: [registry],
            });
            histograms.set(name, histogram);
        }
        return histogram;
    }

    function promGauge(name: MetricName): client.Gauge<string> {
        let gauge = gauges.get(name);
        if (!gauge) {
            gauge = new client.Gauge({
                name,
                help: gaugeSpec(name).help,
                labelNames: [...(gaugeSpec(name).labelNames ?? [])],
                registers: [registry],
            });
            gauges.set(name, gauge);
        }
        return gauge;
    }

    function incrementCounter(name: MetricName, value = 1, labels?: MetricLabels): void {
        try {
            const sanitized = sanitizeLabels(name, counterSpec(name).labelNames, labels);
            if (sanitized) {
                promCounter(name).inc(sanitized, value);
            } else {
                promCounter(name).inc(value);
            }
        } catch (err) {
            logger.warn({ err, metric: name }, '[Metrics] counter update failed');
        }
    }

    function observeTiming(name: TimingMetricName, valueMs: number): void {
        try {
            promSummary(name).observe(valueMs);
        } catch (err) {
            logger.warn({ err, metric: name }, '[Metrics] timing update failed');
        }
    }

    function observeDuration(name: HistogramMetricName, seconds: number, labels?: MetricLabels): void {
        try {
            const sanitized = sanitizeLabels(name, histogramSpec(name).labelNames, labels);
            if (sanitized) {
                promHistogram(name).observe(sanitized, seconds);
            } else {
                promHistogram(name).observe(seconds);
            }
        } catch (err) {
            logger.warn({ err, metric: name }, '[Metrics] histogram update failed');
        }
    }

    function setGauge(name: GaugeMetricName, value: number, labels?: MetricLabels): void {
        try {
            const sanitized = sanitizeLabels(name, gaugeSpec(name).labelNames, labels);
            if (sanitized) {
                promGauge(name).set(sanitized, value);
            } else {
                promGauge(name).set(value);
            }
        } catch (err) {
            logger.warn({ err, metric: name }, '[Metrics] gauge update failed');
        }
    }

    function logStructured(event: string, details: Record<string, unknown>): void {
        logger.info({ event, ...details }, event);
    }

    function registerCollector(collector: () => Promise<void> | void): void {
        collectors.push(collector);
    }

    async function scrape(): Promise<ScrapeResult> {
        const results = await Promise.allSettled(collectors.map((collector) => collector()));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.warn({ err: result.reason, collectorIndex: index }, '[Metrics] collector failed');
            }
        });
        return {
            contentType: registry.contentType,
            body: await registry.metrics(),
        };
    }

    // Series for every known queue and the DLQ exist even before P2a wires
    // real producers/consumers, so alerts can target stable series names.
    for (const queue of KNOWN_QUEUES) {
        setGauge('queue_depth', 0, { queue });
        setGauge('queue_oldest_age_seconds', 0, { queue });
    }
    setGauge('dlq_depth', 0);

    return {
        incrementCounter,
        observeTiming,
        observeDuration,
        setGauge,
        logStructured,
        registerCollector,
        scrape,
        getPromRegistry: () => registry,
    };
}
