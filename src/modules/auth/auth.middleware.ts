import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from './/auth.service.js';

// Production cookies carry the __Host- prefix; dev keeps the plain name.
const ACCESS_TOKEN_COOKIE_NAMES = ['__Host-accessToken', 'accessToken'];

function readAccessTokenFromCookieHeader(rawCookieHeader: string | undefined): string | null {
    if (!rawCookieHeader) {
        return null;
    }

    for (const part of rawCookieHeader.split(';')) {
        const [rawKey, ...rawValue] = part.split('=');
        if (!rawKey || rawValue.length === 0) {
            continue;
        }
        if (!ACCESS_TOKEN_COOKIE_NAMES.includes(rawKey.trim())) {
            continue;
        }
        const value = rawValue.join('=').trim();
        return value.length > 0 ? decodeURIComponent(value) : null;
    }

    return null;
}

function readAccessToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
        return header.slice(7);
    }

    for (const name of ACCESS_TOKEN_COOKIE_NAMES) {
        const cookieToken = req.cookies?.[name];
        if (typeof cookieToken === 'string' && cookieToken.length > 0) {
            return cookieToken;
        }
    }

    const rawCookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie;
    return readAccessTokenFromCookieHeader(rawCookieHeader);
}

export function createAuthMiddleware(authService: AuthService) {
    return (req: Request, res: Response, next: NextFunction) => {
        const token = readAccessToken(req);
        if (!token) {
            res.status(401).json({ error: 'Missing authentication token' });
            return;
        }

        try {
            const payload = authService.verifyAccessToken(token);
            req.userId = payload.sub;
            next();
        } catch {
            res.status(401).json({ error: 'Invalid or expired token' });
        }
    };
}
