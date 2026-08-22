import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import type { AuthService } from '@/services/auth.service.js';
import type { UserService } from '@/services/user.service.js';
import type { Database } from '@/db/client.js';
import type { AuthRouterConfig } from '@/routes/auth/types.js';
import { registerGoogleAuthRoutes } from '@/routes/auth/google.routes.js';
import { registerSessionRoutes } from '@/routes/auth/session.routes.js';

export function createAuthRouter(
    config: AuthRouterConfig,
    authService: AuthService,
    userService: UserService,
    db: Database,
) {
    const router = Router();
    const oauth2Client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);

    const deps = {
        config,
        oauth2Client,
        authService,
        userService,
        db,
    };

    registerGoogleAuthRoutes(router, deps);
    registerSessionRoutes(router, deps);

    return router;
}
