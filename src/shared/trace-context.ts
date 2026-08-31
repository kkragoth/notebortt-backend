import { context as otelContext, propagation } from '@opentelemetry/api';

/**
 * W3C traceparent carry-over for cross-process jobs (P5.4). Lives in shared
 * so both the event bus and any other queue producer/consumer can use it.
 */

export const TRACEPARENT_DATA_KEY = 'traceparent';

/** Captures the active context as a traceparent carrier for a job payload. */
export function injectTraceparent(): string | undefined {
    try {
        const carrier: Record<string, string> = {};
        propagation.inject(otelContext.active(), carrier);
        return carrier[TRACEPARENT_DATA_KEY] || undefined;
    } catch {
        return undefined;
    }
}

/** Restores a propagated context and runs `fn` inside it. */
export async function withJobTraceparent<T>(traceparent: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!traceparent) {
        return fn();
    }
    try {
        const extracted = propagation.extract(otelContext.active(), { [TRACEPARENT_DATA_KEY]: traceparent });
        return await otelContext.with(extracted, fn);
    } catch {
        return fn();
    }
}
