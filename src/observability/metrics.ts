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
}

function metricKey(name: string, tags?: MetricTags): string {
  if (!tags || Object.keys(tags).length === 0) {
    return name
  }

  const tagString = Object.entries(tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(',')

  return `${name}{${tagString}}`
}

export function createRuntimeMetrics(): RuntimeMetrics {
  const counters = new Map<string, number>()
  const timings = new Map<string, { count: number; totalMs: number; maxMs: number }>()

  function record(_event: MetricEvent): void {
    // Keep this hook for future metric sinks.
  }

  function incrementCounter(name: string, value = 1, tags?: MetricTags): void {
    const key = metricKey(name, tags)
    counters.set(key, (counters.get(key) ?? 0) + value)
    record({ type: 'counter', name, value, tags })
  }

  function observeTiming(name: string, valueMs: number, tags?: MetricTags): void {
    const key = metricKey(name, tags)
    const previous = timings.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 }
    const next = {
      count: previous.count + 1,
      totalMs: previous.totalMs + valueMs,
      maxMs: Math.max(previous.maxMs, valueMs),
    }
    timings.set(key, next)
    record({ type: 'timing', name, valueMs, tags })
  }

  function logStructured(event: string, details: Record<string, unknown>): void {
    console.log(JSON.stringify({
      event,
      at: new Date().toISOString(),
      ...details,
    }))
  }

  function getSnapshot() {
    return {
      counters: Object.fromEntries(counters),
      timings: Object.fromEntries(timings),
    }
  }

  return {
    incrementCounter,
    observeTiming,
    logStructured,
    getSnapshot,
  }
}

