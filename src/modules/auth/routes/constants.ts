export const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile'];
export const ACCESS_TOKEN_COOKIE_NAME = 'accessToken';
/**
 * Names accepted when READING the access token: production sets the
 * `__Host-` prefixed cookie (Secure, Path=/, no Domain); dev keeps the
 * plain name so http:// origins keep working.
 */
export const ACCESS_TOKEN_COOKIE_NAMES: readonly string[] = [`__Host-${ACCESS_TOKEN_COOKIE_NAME}`, ACCESS_TOKEN_COOKIE_NAME];
export const REFRESH_TOKEN_COOKIE_NAME = 'refreshToken';
export const REFRESH_TOKEN_COOKIE_PATH = '/auth';
export const OAUTH_STATE_COOKIE_NAME = 'oauthState';
export const OAUTH_PKCE_COOKIE_NAME = 'oauthPkceVerifier';
/** Remembers which allowed frontend origin started the OAuth flow. */
export const OAUTH_ORIGIN_COOKIE_NAME = 'oauthOrigin';
export const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;
