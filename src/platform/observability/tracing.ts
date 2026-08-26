import { SamplingDecision } from '@opentelemetry/api';
import type { Attributes, Sampler, SamplingResult } from '@opentelemetry/api';
import type { BatchSpanProcessor as BatchSpanProcessorType, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';

export { TRACEPARENT_DATA_KEY, injectTraceparent, withJobTraceparent } from '@/shared/trace-context.js';

/**
 * Distributed tracing (P5). Zero-cost until OTEL_EXPORTER_OTLP_ENDPOINT is
 * set: setupTracing resolves to a no-op handle without it.
 *
 * Root sampling (5.2): ParentBased( boardRotation ∥ ratio ) — root spans
 * carrying a board id in their URL attributes are force-sampled when
 * hash(boardId + ISO-week) lands in the rotation bucket (deterministic per
 * board+week, computed in a fixed timezone so every replica agrees);
 * everything else falls through to a plain ratio sampler. Worker spans
 * inherit the parent decision via propagated traceparent — no mid-chain
 * fragmentation for a sampled board.
 */

export const TRACING_FIXED_TIMEZONE = 'UTC';
export const TRACING_SAMPLE_RATIO = 0.1;
export const BOARD_ROTATION_PERCENT = 5;

const BOARD_ID_PATTERN = /boards?\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Incoming HTTP paths whose spans are never recorded (5.3). */
export const SUPPRESSED_URL_PATTERNS: RegExp[] = [
    /^\/socket\.io\//,
    /^\/metrics/,
    /^\/healthz/,
    // /health plus its /live and /ready aliases (orchestrator probes).
    /^\/health(\/|$)/,
];

/** Redis key fragments whose per-command spans are never recorded (5.3):
 * socket tick buffers and mutation/load/eviction lock polling. */
export const SUPPRESSED_SPAN_KEY_PATTERNS: string[] = [
    ':mutation_lock',
    ':load_lock:',
    ':eviction_lock',
];

/** FNV-1a 32-bit — deterministic across processes. */
function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * ISO week key ("2026-W34") computed on the wall clock of the fixed tracing
 * timezone, so week boundaries never disagree between replicas.
 */
// Formatter construction is expensive and the timezone is fixed — build one
// per timezone and reuse it (this sits on the span-sampling hot path).
const isoWeekFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
    let formatter = isoWeekFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        isoWeekFormatters.set(timeZone, formatter);
    }
    return formatter;
}

export function isoWeekKey(date = new Date(), timeZone = TRACING_FIXED_TIMEZONE): string {
    const parts = Object.fromEntries(
        formatterFor(timeZone).formatToParts(date).map((part) => [part.type, part.value]),
    );
    const wallClock = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
    );
    const shifted = new Date(wallClock);

    const dayMs = 86_400_000;
    const dayOfWeek = (shifted.getUTCDay() + 6) % 7;
    const thursday = new Date(shifted.getTime() + (3 - dayOfWeek) * dayMs);
    const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
    const week = Math.floor((thursday.getTime() - yearStart) / dayMs / 7) + 1;
    return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function rotationDecisionForBoard(boardId: string, weekKey = isoWeekKey()): boolean {
    return fnv1a(`${boardId}:${weekKey}`) % 100 < BOARD_ROTATION_PERCENT;
}

function boardIdFromAttributes(attributes?: Attributes): string | undefined {
    if (!attributes) {
        return undefined;
    }
    for (const key of ['http.url', 'http.target', 'url.full', 'url.path']) {
        const value = attributes[key];
        if (typeof value === 'string') {
            const match = BOARD_ID_PATTERN.exec(value);
            if (match?.[1]) {
                return match[1];
            }
        }
    }
    return undefined;
}

class BoardRotationRatioSampler {
    private readonly fallback: Sampler;

    constructor(fallback: Sampler) {
        this.fallback = fallback;
    }

    shouldSample(...args: Parameters<Sampler['shouldSample']>): SamplingResult {
        const [context, traceId, spanName, spanKind, attributes, links] = args;
        const boardId = boardIdFromAttributes(attributes);
        if (boardId && rotationDecisionForBoard(boardId)) {
            return { decision: SamplingDecision.RECORD_AND_SAMPLED };
        }
        return this.fallback.shouldSample(context, traceId, spanName, spanKind, attributes, links);
    }
}

/** Drops spans touching lock/tick redis keys before they hit the exporter. */
class KeyPatternSuppressingSpanProcessor implements SpanProcessor {
    private readonly inner: BatchSpanProcessorType;

    constructor(inner: BatchSpanProcessorType) {
        this.inner = inner;
    }

    private suppressed(span: ReadableSpan): boolean {
        // Scan only the span name and string attribute values — serializing
        // the full attribute bag per ended span is too costly on the hot
        // export path (every ioredis command ends a span).
        let haystack = span.name;
        const attributes = span.attributes;
        for (const key of Object.keys(attributes)) {
            const value = attributes[key];
            if (typeof value === 'string') {
                haystack += ` ${key}=${value}`;
            }
        }
        return SUPPRESSED_SPAN_KEY_PATTERNS.some((pattern) => haystack.includes(pattern));
    }

    onStart(): void {
        // nothing
    }

    onEnd(span: ReadableSpan): void {
        if (this.suppressed(span)) {
            return;
        }
        this.inner.onEnd(span);
    }

    shutdown(): Promise<void> {
        return this.inner.shutdown();
    }

    forceFlush(): Promise<void> {
        return this.inner.forceFlush();
    }
}

export interface TracingHandle {
    started: boolean
    shutdown: () => Promise<void>
}

const NOOP_HANDLE: TracingHandle = { started: false, shutdown: async () => undefined };

export async function setupTracing(app: string): Promise<TracingHandle> {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        return NOOP_HANDLE;
    }

    try {
        const [{ NodeSDK }, sdkBase, { OTLPTraceExporter }, httpMod, expressMod, pgMod, ioredisMod] =
            await Promise.all([
                import('@opentelemetry/sdk-node'),
                import('@opentelemetry/sdk-trace-base'),
                import('@opentelemetry/exporter-trace-otlp-http'),
                import('@opentelemetry/instrumentation-http'),
                import('@opentelemetry/instrumentation-express'),
                import('@opentelemetry/instrumentation-pg'),
                import('@opentelemetry/instrumentation-ioredis'),
            ]);

        const exporter = new OTLPTraceExporter();
        const suppressor = new KeyPatternSuppressingSpanProcessor(new sdkBase.BatchSpanProcessor(exporter));

        const sdk = new NodeSDK({
            serviceName: `note-canva-${app}`,
            // ParentBased: children inherit the root's sampling decision.
            // Without the wrapper every span re-rolls the dice independently,
            // fragmenting traces mid-chain (holes under sampled parents,
            // orphan partials above unsampled ones).
            sampler: new sdkBase.ParentBasedSampler({
                root: new BoardRotationRatioSampler(new sdkBase.TraceIdRatioBasedSampler(TRACING_SAMPLE_RATIO)),
            }),
            spanProcessors: [suppressor],
            instrumentations: [
                new httpMod.HttpInstrumentation({
                    ignoreIncomingRequestHook: (request) =>
                        SUPPRESSED_URL_PATTERNS.some((pattern) => pattern.test(request.url ?? '')),
                }),
                new expressMod.ExpressInstrumentation(),
                new pgMod.PgInstrumentation(),
                new ioredisMod.IORedisInstrumentation(),
            ],
        });
        sdk.start();

        return {
            started: true,
            shutdown: () => sdk.shutdown(),
        };
    } catch (error) {
        console.error('[Tracing] failed to initialize', error);
        return NOOP_HANDLE;
    }
}
