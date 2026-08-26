import { ACCESS_TOKEN_COOKIE_NAMES } from './routes/constants.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService } from './/auth.service.js';

function readCookieToken(req: Request): string | null {
    // Production writes the access token under the `__Host-` prefixed name;
    // dev keeps the plain one (same contract as the required-auth middleware).
    for (const name of ACCESS_TOKEN_COOKIE_NAMES) {
        const token = req.cookies?.[name];
        if (typeof token === 'string' && token.length > 0) {
            return token;
        }
    }
    return null;
}

export function createOptionalAuth(authService: AuthService): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        const header = req.headers.authorization;
        const tokenFromHeader = header?.startsWith('Bearer ') ? header.slice(7) : null;
        const token = tokenFromHeader ?? readCookieToken(req);

        try {
            if (!token) {
                next();
                return;
            }

            const payload = authService.verifyAccessToken(token);
            if (payload.sub) {
                req.userId = payload.sub;
            }
        } catch {
            // Ignore invalid token and continue as unauthenticated.
        }

        next();
    };
}
