import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService } from './/auth.service.js';

export function createOptionalAuth(authService: AuthService): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        const header = req.headers.authorization;
        const tokenFromHeader = header?.startsWith('Bearer ') ? header.slice(7) : null;
        const tokenFromCookie = typeof req.cookies?.accessToken === 'string' ? req.cookies.accessToken : null;
        const token = tokenFromHeader ?? tokenFromCookie;

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
