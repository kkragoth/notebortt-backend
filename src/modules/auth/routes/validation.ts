import {  z } from 'zod';
import type {ZodTypeAny} from 'zod';
import type { Request, Response } from 'express';
import { sendBadRequest } from '@/shared/http.js';
import { parseWithSchema } from '@/shared/validation.js';

const emptyParamsSchema = z.object({}).passthrough();
const emptyQuerySchema = z.object({}).passthrough();
const emptyBodySchema = z.object({}).passthrough();

interface ValidationSchemas {
  params?: ZodTypeAny
  query?: ZodTypeAny
  body?: ZodTypeAny
}

export function validateRequestInput(
    req: Request,
    res: Response,
    schemas: ValidationSchemas = {},
): { params: unknown; query: unknown; body: unknown } | null {
    const parsedParams = parseWithSchema(schemas.params ?? emptyParamsSchema, req.params);
    if (!parsedParams.success) {
        sendBadRequest(res, parsedParams.error.error);
        return null;
    }

    const parsedQuery = parseWithSchema(schemas.query ?? emptyQuerySchema, req.query);
    if (!parsedQuery.success) {
        sendBadRequest(res, parsedQuery.error.error);
        return null;
    }

    const parsedBody = parseWithSchema(schemas.body ?? emptyBodySchema, req.body ?? {});
    if (!parsedBody.success) {
        sendBadRequest(res, parsedBody.error.error);
        return null;
    }

    return {
        params: parsedParams.data,
        query: parsedQuery.data,
        body: parsedBody.data,
    };
}
