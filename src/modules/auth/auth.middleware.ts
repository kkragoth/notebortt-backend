import { ACCESS_TOKEN_COOKIE_NAMES } from './routes/constants.js';
import type { NextFunction, Request, Response } from 'express';
import type { AuthService } from './/auth.service.js';
import { parseCookieHeader } from '@/shared/cookies.js';

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

    // Fallback for handlers that run before cookie-parser (defensive).
    const rawCookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie;
    if (!rawCookieHeader) {
        return null;
    }
    const cookies = parseCookieHeader(rawCookieHeader);
    for (const name of ACCESS_TOKEN_COOKIE_NAMES) {
        const token = cookies[name];
        if (typeof token === 'string' && token.length > 0) {
            return token;
        }
    }
    return null;
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
