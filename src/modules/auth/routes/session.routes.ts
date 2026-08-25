import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
    REFRESH_TOKEN_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_PATH,
} from '../routes/constants.js';
import {
    accessTokenCookieName,
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
import { logger } from '@/shared/logger.js';
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
            .where(eq(refreshTokens.tokenHash, tokenHash))
            .limit(1);

        if (found.length === 0 || found[0].expiresAt <= now) {
            res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(accessTokenCookieName(config), { path: '/' });
            res.status(401).json({ error: 'Invalid or expired refresh token' });
            return;
        }
        const existingToken = found[0];

        // Atomic claim: only one concurrent request can revoke the token.
        // Losing the race means another client already rotated it — i.e. this
        // token was replayed.
        const claimed = await db
            .update(refreshTokens)
            .set({ revokedAt: now })
            .where(and(eq(refreshTokens.id, existingToken.id), isNull(refreshTokens.revokedAt)))
            .returning({ id: refreshTokens.id });

        if (claimed.length === 0) {
            // Reuse of an already-rotated token: assume theft and kill the
            // entire token family so the attacker's copy dies too.
            await db
                .update(refreshTokens)
                .set({ revokedAt: now })
                .where(and(
                    eq(refreshTokens.familyId, existingToken.familyId),
                    isNull(refreshTokens.revokedAt),
                ));
            logger.warn({
                userId: existingToken.userId,
                familyId: existingToken.familyId,
            }, '[Auth] refresh token reuse detected; family revoked');

            res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(accessTokenCookieName(config), { path: '/' });
            res.status(401).json({ error: 'Refresh token reuse detected; session revoked' });
            return;
        }

        const newAccessToken = authService.generateAccessToken(existingToken.userId);
        const newRefreshToken = authService.generateRefreshToken();
        const newTokenHash = authService.hashRefreshToken(newRefreshToken);
        const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays);

        // Rotation stays inside the same family so a later replay can nuke it.
        await db.insert(refreshTokens).values({
            userId: existingToken.userId,
            familyId: existingToken.familyId,
            tokenHash: newTokenHash,
            expiresAt,
        });

        const accessCookieOptions = buildAccessTokenCookieOptions(config);
        const refreshCookieOptions = buildRefreshTokenCookieOptions(config);
        res.cookie(accessTokenCookieName(config), newAccessToken, accessCookieOptions);
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
        res.cookie(accessTokenCookieName(config), accessToken, accessCookieOptions);
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
            // Revoke instead of delete: the row must survive so that a later
            // replay of this token triggers family-wide revocation.
            await db
                .update(refreshTokens)
                .set({ revokedAt: sql`now()` })
                .where(and(
                    eq(refreshTokens.tokenHash, authService.hashRefreshToken(refreshToken)),
                    isNull(refreshTokens.revokedAt),
                ));
        }

        res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
        res.clearCookie(accessTokenCookieName(config), { path: '/' });
        res.sendStatus(200);
    });
}


