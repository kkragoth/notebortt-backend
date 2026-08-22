import express from 'express';
import cookieParser from 'cookie-parser';
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

export function createApp(runtime: AppRuntime) {
    const app = express();

    app.use(createCorsMiddleware(runtime.config.corsOrigin));
    app.use(cookieParser());
    app.use('/', createBillingWebhookRouter(runtime.billingService));
    app.use(express.json());

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

    return app;
}
