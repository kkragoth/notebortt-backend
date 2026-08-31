import {
    GOOGLE_OAUTH_SCOPES,
    OAUTH_ORIGIN_COOKIE_NAME,
    OAUTH_PKCE_COOKIE_NAME,
    OAUTH_STATE_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_NAME,
    REFRESH_TOKEN_COOKIE_PATH,
} from '../routes/constants.js';
import {
    accessTokenCookieName,
    buildAccessTokenCookieOptions,
    buildOAuthCookieOptions,
    buildRefreshTokenCookieOptions,
    buildRefreshTokenExpiry,
    extractGoogleUserInfo,
    generateOAuthState,
    generatePkceVerifier,
    isAllowedOrigin,
    resolveFrontendOriginForRequest,
    toPkceChallenge,
} from '../routes/helpers.js';
import { emptyBodySchema, validateRequestInput } from '../routes/validation.js';
import type { Router } from 'express';
import type { AuthRouterDeps } from '../routes/types.js';
import { logger } from '@/shared/logger.js';
import { sendBadRequest, sendForbidden } from '@/shared/http.js';
import { authCallbackQuerySchema } from '@/shared/openapi/schemas.js';
import { refreshTokens } from '@/platform/db/schema.js';

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
        // Remember which allowed frontend started the flow so the callback
        // can send the user back to the right origin in multi-frontend
        // deploys (validated against the allow-list again on read).
        if (isAllowedOrigin(config, req.headers.origin)) {
            res.cookie(OAUTH_ORIGIN_COOKIE_NAME, req.headers.origin as string, oauthCookieOptions);
        }

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
        // Google redirects users back with ?error=...&state=... when they
        // deny consent or the flow aborts upstream. Handle that branch
        // before schema validation (which demands a `code` and would turn a
        // routine user cancellation into a raw 400 page on the API domain).
        const oauthError = typeof req.query.error === 'string' && req.query.error.length > 0
            ? req.query.error
            : undefined;
        if (oauthError) {
            const errorState = typeof req.query.state === 'string' ? req.query.state : undefined;
            const stateFromCookie = typeof req.cookies[OAUTH_STATE_COOKIE_NAME] === 'string'
                ? req.cookies[OAUTH_STATE_COOKIE_NAME]
                : undefined;
            if (!errorState || !stateFromCookie || stateFromCookie !== errorState) {
                // Forged or stale error redirect: do not reflect anything.
                sendForbidden(res, 'Invalid OAuth state');
                return;
            }
            res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(OAUTH_ORIGIN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            const frontendOrigin = resolveFrontendOriginForRequest(
                config,
                typeof req.cookies[OAUTH_ORIGIN_COOKIE_NAME] === 'string' ? req.cookies[OAUTH_ORIGIN_COOKIE_NAME] : undefined,
            );
            const redirectUrl = new URL('/callback', frontendOrigin);
            redirectUrl.searchParams.set('error', oauthError);
            res.redirect(redirectUrl.toString());
            return;
        }

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
            res.cookie(accessTokenCookieName(config), accessToken, accessCookieOptions);
            res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshCookieOptions);
            res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(OAUTH_ORIGIN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });

            // Prefer the origin that started the flow (cookie value is
            // re-validated against the allow-list inside the helper).
            const flowOrigin = typeof req.cookies[OAUTH_ORIGIN_COOKIE_NAME] === 'string'
                ? req.cookies[OAUTH_ORIGIN_COOKIE_NAME]
                : undefined;
            const redirectUrl = new URL('/callback', resolveFrontendOriginForRequest(config, flowOrigin));
            if (config.enableOauthFragmentTokens) {
                // Tokens ride the redirect fragment on purpose: the API and the
                // frontend live on different origins, and iOS WebKit (ITP) blocks
                // cross-site cookies, so the cookies set above never reach the API
                // from mobile Safari/WebView. The native app consumes location.hash
                // once on /callback and stores tokens in the Keychain; do not treat
                // these as long-lived secrets in browser history. Opt-in only —
                // fragments leak tokens to history and intermediaries.
                metrics?.incrementCounter('oauth_fragment_tokens_total');
                redirectUrl.hash = `access_token=${accessToken}&refresh_token=${refreshToken}`;
            }
            res.redirect(redirectUrl.toString());
        } catch (err) {
            logger.error({ err }, '[Auth] OAuth callback error');
            res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH });
            res.status(500).json({ error: 'Authentication failed' });
        }
    });
}
