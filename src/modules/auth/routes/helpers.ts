import { createHash, randomBytes } from 'node:crypto';
import { ACCESS_TOKEN_COOKIE_NAME, OAUTH_COOKIE_MAX_AGE_MS } from '../routes/constants.js';
import type { AppConfig } from '@/shared/config.js';
import { parseAllowedOrigins } from '@/shared/cors.js';

export function isProduction(config: Pick<AppConfig, 'nodeEnv'>): boolean {
    return config.nodeEnv === 'production';
}

/**
 * `__Host-` cookies require Secure, Path=/ and no Domain — satisfied by the
 * access-token cookie options in production. Dev keeps the plain name so
 * http:// origins keep working.
 */
export function accessTokenCookieName(config: Pick<AppConfig, 'nodeEnv'>): string {
    return isProduction(config) ? `__Host-${ACCESS_TOKEN_COOKIE_NAME}` : ACCESS_TOKEN_COOKIE_NAME;
}

export function buildCookieSecurityOptions(config: Pick<AppConfig, 'nodeEnv'>) {
    if (isProduction(config)) {
        return {
            secure: true,
            sameSite: 'none' as const,
        };
    }

    return {
        secure: false,
        sameSite: 'lax' as const,
    };
}

export function resolveFrontendOrigin(corsOrigin: string): string {
    const allowedOrigins = parseAllowedOrigins(corsOrigin);
    return allowedOrigins.find((origin) => origin.startsWith('https://')) ?? allowedOrigins[0] ?? corsOrigin;
}

export function isAllowedOrigin(config: Pick<AppConfig, 'corsOrigin'>, origin: string | undefined): boolean {
    if (!origin) {
        return false;
    }

    const allowedOrigins = parseAllowedOrigins(config.corsOrigin);
    return allowedOrigins.includes(origin);
}

export function buildRefreshTokenCookieOptions(config: Pick<AppConfig, 'nodeEnv' | 'refreshTokenExpiresDays'>) {
    const maxAgeMs = config.refreshTokenExpiresDays * 24 * 60 * 60 * 1000;
    return {
        httpOnly: true,
        ...buildCookieSecurityOptions(config),
        maxAge: maxAgeMs,
        path: '/auth',
    };
}

export function parseJwtExpiryToMs(raw: string): number {
    const match = raw.match(/^(\d+)([smhd])$/);
    if (!match) {
        return 15 * 60 * 1000;
    }

    const amount = Number.parseInt(match[1] ?? '15', 10);
    const unit = match[2] ?? 'm';
    const unitMultiplier: Record<string, number> = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
    };

    return amount * (unitMultiplier[unit] ?? unitMultiplier.m);
}

export function buildAccessTokenCookieOptions(config: Pick<AppConfig, 'nodeEnv' | 'jwtExpiresIn'>) {
    return {
        httpOnly: true,
        ...buildCookieSecurityOptions(config),
        maxAge: parseJwtExpiryToMs(config.jwtExpiresIn),
        path: '/',
    };
}

export function buildOAuthCookieOptions(config: Pick<AppConfig, 'nodeEnv'>) {
    return {
        httpOnly: true,
        ...buildCookieSecurityOptions(config),
        maxAge: OAUTH_COOKIE_MAX_AGE_MS,
        path: '/auth',
    };
}

export function buildRefreshTokenExpiry(refreshTokenExpiresDays: number): Date {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + refreshTokenExpiresDays);
    return expiresAt;
}

export function extractGoogleUserInfo(payload: { email?: string; name?: string; picture?: string; sub?: string }) {
    const email = payload.email ?? '';
    const name = payload.name ?? '';
    const avatarUrl = payload.picture ?? null;
    const googleId = payload.sub ?? '';
    return { email, name, avatarUrl, googleId };
}

export function generateOAuthState(): string {
    return randomBytes(24).toString('base64url');
}

export function generatePkceVerifier(): string {
    return randomBytes(32).toString('base64url');
}

export function toPkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}
