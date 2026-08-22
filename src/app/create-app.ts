import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { AppRuntime } from '@/app/runtime.js';
import { createCorsMiddleware } from '@/middleware/cors.js';
import { createAuthRouter } from '@/routes/auth.js';
import { createBoardRouter } from '@/routes/boards.js';
import { createBillingRouter, createBillingWebhookRouter } from '@/routes/billing.js';
import { createDebugRouter } from '@/routes/debug.js';
import { healthRoute } from '@/routes/health.js';
import { createOpenApiRouter } from '@/routes/openapi.js';
import { createSwaggerRouter } from '@/routes/swagger.js';
import { createUserRouter } from '@/routes/users.js';
import { createWorkspaceRouter } from '@/routes/workspaces.js';
import { errorHandler, jsonNotFoundHandler } from '@/lib/errors.js';

const GLOBAL_RATE_LIMIT_MAX = 300;
const GLOBAL_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX = 20;
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const JSON_BODY_LIMIT = '1mb';

export function createApp(runtime: AppRuntime) {
    const app = express();

    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    // CSP stays disabled: Swagger UI relies on inline scripts.
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(createCorsMiddleware(runtime.config.corsOrigin));
    app.use(cookieParser());

    const globalLimiter = rateLimit({
        windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
        limit: GLOBAL_RATE_LIMIT_MAX,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        skip: (req) => req.path === '/health',
    });
    const authLimiter = rateLimit({
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        limit: AUTH_RATE_LIMIT_MAX,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
    });

    app.use(globalLimiter);
    app.use('/auth', authLimiter);

    // Stripe webhook must see the raw body, so it stays before express.json().
    app.use('/', createBillingWebhookRouter(runtime.billingService));
    app.use(express.json({ limit: JSON_BODY_LIMIT }));

    app.get('/health', healthRoute(runtime.db, runtime.redis));
    app.use('/debug', createDebugRouter(runtime));
    app.use('/', createOpenApiRouter(runtime.config));
    app.use('/swagger', createSwaggerRouter(runtime.config));
    app.use('/auth', createAuthRouter(runtime.config, runtime.authService, runtime.userService, runtime.db));
    app.use('/users', createUserRouter(runtime.userService, runtime.authMiddleware));
    app.use('/', createBillingRouter(runtime.billingService, runtime.authMiddleware));
    app.use('/', createWorkspaceRouter(runtime.workspaceService, runtime.authMiddleware));
    app.use('/', createBoardRouter(
        runtime.boardService,
        runtime.workspaceService,
        runtime.authMiddleware,
        runtime.boardStateService,
        runtime.mutationProcessor,
        runtime.authService,
        runtime.previewJobService,
    ));

    app.use(jsonNotFoundHandler);
    app.use(errorHandler);

    return app;
}
