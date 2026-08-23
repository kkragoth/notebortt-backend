import {  z } from 'zod';
import type {ZodType} from 'zod';

export interface ValidationFailure {
  error: string
  details: z.ZodIssue[]
}

export function parseWithSchema<TSchema extends ZodType>(
    schema: TSchema,
    input: unknown,
): { success: true; data: z.infer<TSchema> } | { success: false; error: ValidationFailure } {
    const parsed = schema.safeParse(input);

    if (parsed.success) {
        return { success: true, data: parsed.data };
    }

    return {
        success: false,
        error: {
            error: parsed.error.issues[0]?.message ?? 'Invalid request',
            details: parsed.error.issues,
        },
    };
}
