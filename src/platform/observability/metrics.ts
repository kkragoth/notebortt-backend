import client from 'prom-client';
import { logger } from '@/shared/logger.js';

type MetricTags = Record<string, string | number | boolean>

interface CounterMetric {
  type: 'counter'
  name: string
  value: number
  tags?: MetricTags
}

interface TimingMetric {
  type: 'timing'
  name: string
  valueMs: number
  tags?: MetricTags
}

type MetricEvent = CounterMetric | TimingMetric

export interface RuntimeMetrics {
  incrementCounter: (name: string, value?: number, tags?: MetricTags) => void
  observeTiming: (name: string, valueMs: number, tags?: MetricTags) => void
  logStructured: (event: string, details: Record<string, unknown>) => void
  getSnapshot: () => {
    counters: Record<string, number>
    timings: Record<string, { count: number; totalMs: number; maxMs: number }>
  }
  getPromRegistry: () => client.Registry
}

function metricKey(name: string, tags?: MetricTags): string {
    if (!tags || Object.keys(tags).length === 0) {
        return name;
    }

    const tagString = Object.entries(tags)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(',');

    return `${name}{${tagString}}`;
}

// Prometheus label names must be static per metric; dynamic tag keys are
// folded into a single bounded `tagset` label to keep cardinality safe.
function toPromName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

export function createRuntimeMetrics(): RuntimeMetrics {
    const counters = new Map<string, number>();
    const timings = new Map<string, { count: number; totalMs: number; maxMs: number }>();

    const registry = new client.Registry();
    client.collectDefaultMetrics({ register: registry });

    const promCounters = new Map<string, client.Counter<string>>();
    const promSummaries = new Map<string, client.Summary<string>>();

    function promCounter(name: string): client.Counter<string> {
        const promName = toPromName(name);
        let counter = promCounters.get(promName);
        if (!counter) {
            counter = new client.Counter({
                name: `${promName}_total`,
                help: `Counter ${name}`,
                labelNames: ['tagset'],
                registers: [registry],
            });
            promCounters.set(promName, counter);
        }
        return counter;
    }

    function promSummary(name: string): client.Summary<string> {
        const promName = toPromName(name);
        let summary = promSummaries.get(promName);
        if (!summary) {
            summary = new client.Summary({
                name: `${promName}_ms`,
                help: `Timing ${name} (ms)`,
                labelNames: ['tagset'],
                registers: [registry],
            });
            promSummaries.set(promName, summary);
        }
        return summary;
    }

    function record(event: MetricEvent): void {
        const tagset = metricKey('', event.tags).replace(/^\{/, '').replace(/\}$/, '') || 'none';
        try {
            if (event.type === 'counter') {
                promCounter(event.name).inc({ tagset }, event.value);
            } else {
                promSummary(event.name).observe({ tagset }, event.valueMs);
            }
        } catch (err) {
            logger.warn({ err, metric: event.name }, '[Metrics] prometheus update failed');
        }
    }

    function incrementCounter(name: string, value = 1, tags?: MetricTags): void {
        const key = metricKey(name, tags);
        counters.set(key, (counters.get(key) ?? 0) + value);
        record({ type: 'counter', name, value, tags });
    }

    function observeTiming(name: string, valueMs: number, tags?: MetricTags): void {
        const key = metricKey(name, tags);
        const previous = timings.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
        const next = {
            count: previous.count + 1,
            totalMs: previous.totalMs + valueMs,
            maxMs: Math.max(previous.maxMs, valueMs),
        };
        timings.set(key, next);
        record({ type: 'timing', name, valueMs, tags });
    }

    function logStructured(event: string, details: Record<string, unknown>): void {
        logger.info({ event, ...details }, event);
    }

    function getSnapshot() {
        return {
            counters: Object.fromEntries(counters),
            timings: Object.fromEntries(timings),
        };
    }

    function getPromRegistry(): client.Registry {
        return registry;
    }

    return {
        incrementCounter,
        observeTiming,
        logStructured,
        getSnapshot,
        getPromRegistry,
    };
}
