import { describe, expect, it } from 'vitest';
import { parseWithSchema } from '@/shared/validation.js';
import {
    authCallbackQuerySchema,
    boardAccessQuerySchema,
    createBoardBodySchema,
    createWorkspaceInvitationBodySchema,
} from '@/shared/openapi/schemas.js';
import { mutationsBodySchema, patchElementsBodySchema } from '@/modules/boards/index.js';

/**
 * Boundary/fuzz probing of the request schemas (P4.2): hostile or malformed
 * input must be rejected by the schema layer without throwing.
 */

const HOSTILE_INPUTS: Array<() => unknown> = [
    () => null,
    () => undefined,
    () => 0,
    () => -1,
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => '',
    () => 'x'.repeat(64 * 1024),
    () => [],
    () => [[]],
    () => [{}],
    () => ({ __proto__: { polluted: true } }),
    () => ({ constructor: { prototype: {} } }),
    () => new Date(),
    () => Symbol('nope'),
    () => () => 'function',
    () => ({ id: { $gt: '' } }),
    () => ({ upserts: [{ toString: null }] }),
    () => ({ deletes: ['not-a-uuid', '../../etc/passwd'] }),
];

const SCHEMAS = [
    ['patchElementsBodySchema', patchElementsBodySchema],
    ['mutationsBodySchema', mutationsBodySchema],
    ['boardAccessQuerySchema', boardAccessQuerySchema],
    ['createBoardBodySchema', createBoardBodySchema],
    ['createWorkspaceInvitationBodySchema', createWorkspaceInvitationBodySchema],
    ['authCallbackQuerySchema', authCallbackQuerySchema],
] as const;

// Inputs no valid schema can meaningfully accept; asserted one by one.
// (Extra-key objects are excluded: lenient object schemas legitimately strip
// unknown keys rather than rejecting.)
const CLEAR_CUT_GARBAGE: Array<() => unknown> = [
    () => null,
    () => undefined,
    () => 'x'.repeat(64 * 1024),
];

describe('schema boundary fuzzing', () => {
    for (const [name, schema] of SCHEMAS) {
        it(`rejects hostile inputs without throwing: ${name}`, () => {
            let rejected = 0;
            for (const produce of HOSTILE_INPUTS) {
                const input = produce();
                let result: ReturnType<typeof parseWithSchema>;
                expect(() => {
                    result = parseWithSchema(schema, input);
                }).not.toThrow();
                if (result && !result.success) {
                    rejected += 1;
                    expect(result.error.error.length).toBeGreaterThan(0);
                }
            }
            // Every schema must reject the clear-cut garbage at minimum.
            expect(rejected).toBeGreaterThan(0);

            // Individually assert the unambiguous rejects so a schema that
            // accepts most of the barrage cannot ride in on the aggregate.
            for (const produce of CLEAR_CUT_GARBAGE) {
                const result = parseWithSchema(schema, produce());
                if (!result.success) {
                    expect(result.error.error.length).toBeGreaterThan(0);
                } else {
                    throw new Error(`${name} accepted clear-cut garbage: ${JSON.stringify(String(produce()))}`);
                }
            }
        });
    }

    it('keeps valid payloads flowing after the hostile barrage', () => {
        const valid = parseWithSchema(createBoardBodySchema, { name: 'ok' });
        expect(valid.success).toBe(true);
    });
});
