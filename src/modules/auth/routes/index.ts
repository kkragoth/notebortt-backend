import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { registerGoogleAuthRoutes } from '../routes/google.routes.js';
import { registerSessionRoutes } from '../routes/session.routes.js';
import type { AuthService } from '../auth.service.js';
import type { UserService } from '@/modules/users/index.js';
import type { Database } from '@/platform/db/client.js';
import type { RuntimeMetrics } from '@/platform/observability/metrics.js';
import type { AuthRouterConfig } from '../routes/types.js';

export function createAuthRouter(
    config: AuthRouterConfig,
    authService: AuthService,
    userService: UserService,
    db: Database,
    metrics?: RuntimeMetrics,
) {
    const router = Router();
    const oauth2Client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);

    const deps = {
        config,
        oauth2Client,
        authService,
        userService,
        db,
        metrics,
    };

    registerGoogleAuthRoutes(router, deps);
    registerSessionRoutes(router, deps);

    return router;
}
