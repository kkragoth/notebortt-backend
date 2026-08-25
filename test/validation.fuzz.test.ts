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
        });
    }

    it('keeps valid payloads flowing after the hostile barrage', () => {
        const valid = parseWithSchema(createBoardBodySchema, { name: 'ok' });
        expect(valid.success).toBe(true);
    });
});
