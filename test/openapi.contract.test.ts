import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { collectLiveRoutes } from './helpers/route-walker.js';
import { closeFixtures } from './helpers/fixtures.js';
import type { Express } from 'express';
import type { AppConfig } from '@/shared/config.js';
import type { AppRuntime } from '@/app/runtime.js';
import { loadConfig } from '@/shared/config.js';
import { createAppRuntime } from '@/app/runtime.js';
import { API_V1_PREFIX, createApp } from '@/app/create-app.js';
import { INTERNAL_ROUTE_PATHS, createOpenApiDocument, healthResponseSchema } from '@/app/openapi/document.js';

/**
 * OpenAPI contract test (P4.1): the live Express route table and the
 * published OpenAPI document must not drift. Ops/infra surfaces listed in
 * INTERNAL_ROUTE_PATHS are exempt.
 */

const config: AppConfig = loadConfig();
const runtime = createAppRuntime(config, { app: 'api' });
// Second runtime for the capture pass so the first app stays requestable.
const runtime2 = createAppRuntime(config, { app: 'api' });
const app: Express = createApp(runtime);

afterAll(async () => {
    const { shutdownInfra } = await import('@/apps/app-shell.js');
    await shutdownInfra(runtime);
    await shutdownInfra(runtime2).catch(() => undefined);
    await closeFixtures();
});

describe('openapi contract', () => {
    it('documents every live product route and vice versa', () => {
        const document = createOpenApiDocument();
        const documentedPaths = new Set(Object.keys(document.paths ?? {}));

        // The legacy unversioned mirror mounts the same product routes a
        // second time without the prefix; contract-check the canonical one.
        const allLiveRoutes = collectLiveRoutes(() => createApp(runtime2));
        const canonicalProductRoutes = allLiveRoutes
            .filter((route) => route.path.startsWith(`${API_V1_PREFIX}/`))
            .map((route) => ({
                method: route.method,
                path: route.path.slice(API_V1_PREFIX.length) || '/',
            }));

        expect(canonicalProductRoutes.length).toBeGreaterThan(20);

        const undocumented = canonicalProductRoutes.filter((route) => !documentedPaths.has(route.path));

        const deadDocumented = [...documentedPaths].filter((path) => {
            if (INTERNAL_ROUTE_PATHS.has(path)) {
                return false;
            }
            // Documented ops surfaces (/health) mount outside /api/v1.
            return !allLiveRoutes.some((route) => route.path === path);
        });

        expect(
            undocumented,
            `Live routes missing from the OpenAPI document:\n${undocumented.map((r) => `${r.method} ${r.path}`).join('\n')}`,
        ).toEqual([]);
        expect(
            deadDocumented,
            `Documented routes with no live mount:\n${deadDocumented.join('\n')}`,
        ).toEqual([]);
    });

    it('excludes only known internal surfaces from the document', () => {
        for (const path of INTERNAL_ROUTE_PATHS) {
            expect(documentedHas(createOpenApiDocument(), path)).toBe(false);
        }
    });

    it('serves the openapi document from its own endpoint', async () => {
        const res = await request(app).get('/openapi.json');
        expect(res.status).toBe(200);
        expect(res.body.openapi).toBe('3.1.0');
    });

    it('validates live responses against their documented schemas', async () => {
        const health = await request(app).get('/health');
        if (health.status === 200) {
            const parsed = healthResponseSchema.safeParse(health.body);
            expect(parsed.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)).toBeUndefined();
            expect(parsed.success).toBe(true);
        } else {
            // Degraded responses must still match the documented envelope.
            const parsed = healthResponseSchema.safeParse(health.body);
            expect(parsed.success).toBe(true);
        }
    });
});

function documentedHas(document: ReturnType<typeof createOpenApiDocument>, path: string): boolean {
    return Object.keys(document.paths ?? {}).includes(path);
}
