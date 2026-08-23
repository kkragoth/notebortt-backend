import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import {
    ACCESS_TOKEN_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_PATH,
} from '../routes/constants.js';
import {
    buildAccessTokenCookieOptions,
    buildRefreshTokenCookieOptions,
    buildRefreshTokenExpiry,
    isAllowedOrigin,
} from '../routes/helpers.js';
import { validateRequestInput } from '../routes/validation.js';
import type { Router } from 'express';
import type { AuthRouterDeps } from '../routes/types.js';
import { sendForbidden, sendNotFound } from '@/shared/http.js';
import { devLoginBodySchema } from '@/shared/openapi/schemas.js';
import { refreshTokens } from '@/platform/db/schema.js';

const emptyBodySchema = z.object({}).passthrough();

export function registerSessionRoutes(router: Router, deps: AuthRouterDeps) {
    const {
        config,
        authService,
        userService,
        db,
    } = deps;

    router.post('/refresh', async (req, res) => {
        const validated = validateRequestInput(req, res, { body: emptyBodySchema });
        if (!validated) {
            return;
        }

        if (!isAllowedOrigin(config, req.headers.origin)) {
            sendForbidden(res, 'Untrusted origin');
            return;
        }

        let refreshToken = req.cookies[REFRESH_TOKEN_COOKIE_NAME] as string | undefined;
        if (!refreshToken) {
            refreshToken = req.body.refreshToken as string | undefined;
            if (!refreshToken) {
                res.status(401).json({ error: 'Missing refresh token' });
                return;
            }
        }

        const tokenHash = authService.hashRefreshToken(refreshToken);
        const now = new Date();

        const found = await db
            .select()
            .from(refreshTokens)
            .where(and(eq(refreshTokens.tokenHash, tokenHash), gt(refreshTokens.expiresAt, now)))
            .limit(1);

        if (found.length === 0) {
            res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' });
            res.status(401).json({ error: 'Invalid or expired refresh token' });
            return;
        }

        const existingToken = found[0];
        await db.delete(refreshTokens).where(eq(refreshTokens.id, existingToken.id));

        const newAccessToken = authService.generateAccessToken(existingToken.userId);
        const newRefreshToken = authService.generateRefreshToken();
        const newTokenHash = authService.hashRefreshToken(newRefreshToken);
        const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays);

        await db.insert(refreshTokens).values({ userId: existingToken.userId, tokenHash: newTokenHash, expiresAt });

        const accessCookieOptions = buildAccessTokenCookieOptions(config);
        const refreshCookieOptions = buildRefreshTokenCookieOptions(config);
        res.cookie(ACCESS_TOKEN_COOKIE_NAME, newAccessToken, accessCookieOptions);
        res.cookie(REFRESH_TOKEN_COOKIE_NAME, newRefreshToken, refreshCookieOptions);
        res.set('Connection', 'close');
        res.json({
            ok: true,
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
        });
    });

    router.post('/dev-login', async (req, res) => {
        const validated = validateRequestInput(req, res, { body: devLoginBodySchema });
        if (!validated) {
            return;
        }

        if (config.nodeEnv !== 'development') {
            sendNotFound(res, 'Not found');
            return;
        }

        if (!isAllowedOrigin(config, req.headers.origin)) {
            sendForbidden(res, 'Untrusted origin');
            return;
        }

        const body = validated.body as { email: string };
        const user = await userService.getUserByEmail(body.email);
        if (!user) {
            sendNotFound(res, 'User not found. Run: just db-seed');
            return;
        }

        const accessToken = authService.generateAccessToken(user.id);
        const refreshToken = authService.generateRefreshToken();
        const tokenHash = authService.hashRefreshToken(refreshToken);
        const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays);

        await db.insert(refreshTokens).values({ userId: user.id, tokenHash, expiresAt });

        const accessCookieOptions = buildAccessTokenCookieOptions(config);
        const refreshCookieOptions = buildRefreshTokenCookieOptions(config);
        res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, accessCookieOptions);
        res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshCookieOptions);
        res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } });
    });

    router.post('/logout', async (req, res) => {
        const validated = validateRequestInput(req, res, { body: emptyBodySchema });
        if (!validated) {
            return;
        }

        if (!isAllowedOrigin(config, req.headers.origin)) {
            sendForbidden(res, 'Untrusted origin');
            return;
        }

        let refreshToken = req.cookies[REFRESH_TOKEN_COOKIE_NAME] as string | undefined;
        if (!refreshToken) {
            refreshToken = req.body.refreshToken as string | undefined;
        }
        if (refreshToken) {
            const tokenHash = authService.hashRefreshToken(refreshToken);
            await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
        }

        res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
        res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' });
        res.sendStatus(200);
    });
}
