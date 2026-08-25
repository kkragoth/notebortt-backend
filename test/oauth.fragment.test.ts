import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beginRollbackTx, closeFixtures } from './helpers/fixtures.js';
import type { RollbackTxHandle } from './helpers/fixtures.js';
import type { AuthRouterDeps } from '@/modules/auth/routes/types.js';
import { loadConfig } from '@/shared/config.js';
import { createAuthService } from '@/modules/auth/auth.service.js';
import { createUserService } from '@/modules/users/index.js';
import { registerGoogleAuthRoutes } from '@/modules/auth/routes/google.routes.js';
import { OAUTH_PKCE_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from '@/modules/auth/routes/constants.js';

const config = loadConfig();
const authService = createAuthService(config);

// The Google OAuth round-trip is stubbed at the client boundary: the smoke
// target is the callback's redirect shape (fragment tokens vs cookies only).
function makeOauth2Client() {
    return {
        generateAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?stub=1'),
        getToken: vi.fn(async () => ({ tokens: { id_token: 'stub-id-token' } })),
        verifyIdToken: vi.fn(async () => ({
            getPayload: () => ({
                sub: `google-${Date.now()}`,
                email: `fragment-smoke-${Date.now()}@example.com`,
                name: 'Fragment Smoke',
                picture: null,
            }),
        })),
    } as unknown as AuthRouterDeps['oauth2Client'];
}

function buildApp(deps: AuthRouterDeps) {
    const app = express();
    app.use(cookieParser());
    registerGoogleAuthRoutes(app, deps);
    return app;
}

describe('oauth callback fragment tokens', () => {
    let tx: RollbackTxHandle;

    beforeAll(async () => {
        tx = await beginRollbackTx();
    });

    afterAll(async () => {
        await tx.rollback();
        await closeFixtures();
    });

    async function completeCallback(deps: AuthRouterDeps) {
        const app = buildApp(deps);
        const start = await request(app).get('/google');
        expect(start.status).toBe(302);

        const setCookies = Array.isArray(start.headers['set-cookie'])
            ? start.headers['set-cookie']
            : [start.headers['set-cookie']];
        const stateCookie = setCookies.find((value) => value.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
        const verifierCookie = setCookies.find((value) => value.startsWith(`${OAUTH_PKCE_COOKIE_NAME}=`));
        expect(stateCookie).toBeDefined();
        expect(verifierCookie).toBeDefined();

        const state = decodeURIComponent(stateCookie!.split(';')[0]!.split('=')[1]);

        return request(app)
            .get('/callback')
            .query({ code: 'stub-code', state })
            .set('Cookie', [
                stateCookie!.split(';')[0]!,
                verifierCookie!.split(';')[0]!,
            ]);
    }

    it('never emits tokens in the redirect fragment when the flag is off', async () => {
        const res = await completeCallback({
            config: { ...config, nodeEnv: 'test', enableOauthFragmentTokens: false },
            oauth2Client: makeOauth2Client(),
            authService,
            userService: createUserService(tx.db),
            db: tx.db,
        } as AuthRouterDeps);

        expect(res.status).toBe(302);
        const location = res.headers.location;
        expect(location.startsWith('/callback') || new URL(location).pathname === '/callback').toBe(true);
        expect(location.includes('#access_token=')).toBe(false);
        // Session still established via httpOnly cookies.
        const setCookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
        expect(setCookies.some((value) => value.includes('accessToken='))).toBe(true);
        expect(setCookies.some((value) => value.includes('refreshToken='))).toBe(true);
    });

    it('still supports the mobile fragment flow as an explicit opt-in', async () => {
        const res = await completeCallback({
            config: { ...config, nodeEnv: 'test', enableOauthFragmentTokens: true },
            oauth2Client: makeOauth2Client(),
            authService,
            userService: createUserService(tx.db),
            db: tx.db,
        } as AuthRouterDeps);

        expect(res.status).toBe(302);
        expect((res.headers.location)).toContain('#access_token=');
    });
});
