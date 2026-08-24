import { z } from 'zod';
import {
    ACCESS_TOKEN_COOKIE_NAME,
    GOOGLE_OAUTH_SCOPES,
    OAUTH_PKCE_COOKIE_NAME,
    OAUTH_STATE_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_NAME,
} from '../routes/constants.js';
import {
    buildAccessTokenCookieOptions,
    buildOAuthCookieOptions,
    buildRefreshTokenCookieOptions,
    buildRefreshTokenExpiry,
    extractGoogleUserInfo,
    generateOAuthState,
    generatePkceVerifier,
    resolveFrontendOrigin,
    toPkceChallenge,
} from '../routes/helpers.js';
import { validateRequestInput } from '../routes/validation.js';
import type { Router } from 'express';
import type { AuthRouterDeps } from '../routes/types.js';
import { logger } from '@/shared/logger.js';
import { sendBadRequest, sendForbidden } from '@/shared/http.js';
import { authCallbackQuerySchema } from '@/shared/openapi/schemas.js';
import { refreshTokens } from '@/platform/db/schema.js';

const emptyBodySchema = z.object({}).passthrough();

export function registerGoogleAuthRoutes(router: Router, deps: AuthRouterDeps) {
    const {
        config,
        oauth2Client,
        authService,
        userService,
        db,
        metrics,
    } = deps;

    router.get('/google', (req, res) => {
        const validated = validateRequestInput(req, res, { body: emptyBodySchema });
        if (!validated) {
            return;
        }

        const state = generateOAuthState();
        const verifier = generatePkceVerifier();
        const challenge = toPkceChallenge(verifier);
        const oauthCookieOptions = buildOAuthCookieOptions(config);

        res.cookie(OAUTH_STATE_COOKIE_NAME, state, oauthCookieOptions);
        res.cookie(OAUTH_PKCE_COOKIE_NAME, verifier, oauthCookieOptions);

        const url = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: GOOGLE_OAUTH_SCOPES,
            state,
            code_challenge_method: 'S256' as any,
            code_challenge: challenge,
        });
        res.redirect(url);
    });

    router.get('/callback', async (req, res) => {
        const validated = validateRequestInput(req, res, {
            query: authCallbackQuerySchema,
            body: emptyBodySchema,
        });
        if (!validated) {
            return;
        }

        const query = validated.query as { code: string; state: string };
        const stateFromCookie = req.cookies[OAUTH_STATE_COOKIE_NAME] as string | undefined;
        const verifier = req.cookies[OAUTH_PKCE_COOKIE_NAME] as string | undefined;

        if (!stateFromCookie || stateFromCookie !== query.state || !verifier) {
            res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' });
            res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: '/auth' });
            sendForbidden(res, 'Invalid OAuth state');
            return;
        }

        try {
            const { tokens } = await oauth2Client.getToken({
                code: query.code,
                codeVerifier: verifier,
            });

            const idToken = tokens.id_token;
            if (!idToken) {
                sendBadRequest(res, 'Missing id_token from Google');
                return;
            }

            const ticket = await oauth2Client.verifyIdToken({ idToken, audience: config.googleClientId });
            const payload = ticket.getPayload();

            if (!payload) {
                sendBadRequest(res, 'Invalid Google token payload');
                return;
            }

            const { email, name, avatarUrl, googleId } = extractGoogleUserInfo(payload);
            const user = await userService.upsertGoogleUser({ email, name, avatarUrl, googleId });

            const accessToken = authService.generateAccessToken(user.id);
            const refreshToken = authService.generateRefreshToken();
            const tokenHash = authService.hashRefreshToken(refreshToken);
            const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays);

            await db.insert(refreshTokens).values({ userId: user.id, tokenHash, expiresAt });

            const accessCookieOptions = buildAccessTokenCookieOptions(config);
            const refreshCookieOptions = buildRefreshTokenCookieOptions(config);
            res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, accessCookieOptions);
            res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshCookieOptions);
            res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' });
            res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: '/auth' });

            const redirectUrl = new URL('/callback', resolveFrontendOrigin(config.corsOrigin));
            // Tokens ride the redirect fragment on purpose: the API and the
            // frontend live on different origins, and iOS WebKit (ITP) blocks
            // cross-site cookies, so the cookies set above never reach the API
            // from mobile Safari/WebView. The native app consumes location.hash
            // once on /callback and stores tokens in the Keychain; do not treat
            // these as long-lived secrets in browser history.
            metrics?.incrementCounter('oauth_fragment_tokens_total');
            redirectUrl.hash = `access_token=${accessToken}&refresh_token=${refreshToken}`;
            res.redirect(redirectUrl.toString());
        } catch (err) {
            logger.error({ err }, '[Auth] OAuth callback error');
            res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' });
            res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: '/auth' });
            res.status(500).json({ error: 'Authentication failed' });
        }
    });
}
