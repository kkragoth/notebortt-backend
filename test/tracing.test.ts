import { describe, expect, it } from 'vitest';
import {
    BOARD_ROTATION_PERCENT,
    SUPPRESSED_SPAN_KEY_PATTERNS,
    SUPPRESSED_URL_PATTERNS,
    injectTraceparent,
    isoWeekKey,
    rotationDecisionForBoard,
    setupTracing,
    withJobTraceparent,
} from '@/platform/observability/tracing.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function syntheticBoards(count: number): string[] {
    return Array.from({ length: count }, (_, index) => {
        const hex = index.toString(16).padStart(4, '0').repeat(8);
        return `${hex.slice(0, 8)}-1111-4111-8111-${hex.slice(0, 12)}`.toLowerCase();
    });
}

describe('tracing sampling (5.2)', () => {
    it('computes a stable ISO week key in the fixed timezone', () => {
        expect(isoWeekKey(new Date('2026-08-24T12:00:00Z'))).toMatch(/^20\d{2}-W\d{2}$/);
        // Same instant expressed from a far-east offset still lands on the
        // fixed-timezone week key.
        expect(isoWeekKey(new Date('2026-01-01T00:30:00+14:00'))).toBe(isoWeekKey(new Date('2026-01-01T00:30:00Z')));
        // Week boundary sanity: 2026-01-04 is ISO Sunday of W1; the 29th is W53.
        expect(isoWeekKey(new Date('2026-01-01T00:00:00Z'))).not.toBe(isoWeekKey(new Date('2026-01-07T00:00:00Z')));
    });

    it('is deterministic per board+week', () => {
        const boardId = '7dfcd138-1d31-4e53-b88c-200d2b05fe6a';
        const first = rotationDecisionForBoard(boardId, '2026-W34');
        for (let i = 0; i < 10; i += 1) {
            expect(rotationDecisionForBoard(boardId, '2026-W34')).toBe(first);
        }
    });

    it('selects roughly BOARD_ROTATION_PERCENT of boards per week', () => {
        const boards = syntheticBoards(4000);
        let selected = 0;
        for (const boardId of boards) {
            if (rotationDecisionForBoard(boardId, '2026-W34')) {
                selected += 1;
            }
        }
        const share = selected / boards.length;
        expect(share).toBeGreaterThanOrEqual(0.02);
        expect(share).toBeLessThanOrEqual(0.09);
        expect(BOARD_ROTATION_PERCENT).toBe(5);
    });
});

describe('suppression configuration (5.3)', () => {
    it('suppresses socket.io handshakes and probe surfaces', () => {
        expect(SUPPRESSED_URL_PATTERNS.some((pattern) => pattern.test('/socket.io/?EIO=4'))).toBe(true);
        expect(SUPPRESSED_URL_PATTERNS.some((pattern) => pattern.test('/metrics'))).toBe(true);
        expect(SUPPRESSED_URL_PATTERNS.some((pattern) => pattern.test('/healthz'))).toBe(true);
        // Product traffic stays observable.
        expect(SUPPRESSED_URL_PATTERNS.some((pattern) => pattern.test('/api/v1/boards'))).toBe(false);
    });

    it('lists lock-polling redis keys as suppressed span content', () => {
        const haystack = `set {"db.statement":"set board:123:mutation_lock"}`;
        expect(SUPPRESSED_SPAN_KEY_PATTERNS.some((pattern) => haystack.includes(pattern))).toBe(true);
    });
});

describe('bullmq traceparent propagation (5.4)', () => {
    it('injects undefined safely with no active span and runs fn unchanged', async () => {
        expect(injectTraceparent()).toBeUndefined();
        await expect(withJobTraceparent(undefined, async () => 'value')).resolves.toBe('value');
    });

    it('restores a well-formed traceparent into fn execution', async () => {
        const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        await expect(withJobTraceparent(traceparent, async () => 'ok')).resolves.toBe('ok');
    });

    it('produces valid uuid-shaped ids for the fixture helper itself', () => {
        expect(UUID_PATTERN.test('7dfcd138-1d31-4e53-b88c-200d2b05fe6a')).toBe(true);
    });
});

describe('setupTracing lifecycle', () => {
    it('stays a no-op without OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
        const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
        try {
            const handle = await setupTracing('api');
            expect(handle.started).toBe(false);
            await expect(handle.shutdown()).resolves.toBeUndefined();
        } finally {
            if (previous !== undefined) {
                process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous;
            }
        }
    });
});
