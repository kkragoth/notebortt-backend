import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { RedisStore } from 'rate-limit-redis';
import type { RedisReply, SendCommandFn } from 'rate-limit-redis';
import type { Queue } from 'bullmq';
import type { AppRuntime } from '@/app/runtime.js';
import { createCorsMiddleware } from '@/shared/cors.js';
import { logger } from '@/shared/logger.js';
import { createAuthRouter } from '@/modules/auth/index.js';
import { createUserRouter } from '@/modules/users/index.js';
import { createWorkspaceRouter } from '@/modules/workspaces/index.js';
import { createBoardRouter } from '@/modules/boards/index.js';
import { createBillingRouter, createBillingWebhookRouter } from '@/modules/billing/index.js';
import { createDebugRouter } from '@/app/debug.routes.js';
import { healthRoute, livenessRoute } from '@/app/health.routes.js';
import { createMetricsRoute } from '@/app/metrics.routes.js';
import { BULL_BOARD_BASE_PATH, createBasicAuthGate, createBullBoardRouter } from '@/app/bull-board.routes.js';
import { createOpenApiRouter } from '@/app/openapi.routes.js';
import { createSwaggerRouter } from '@/app/swagger.routes.js';
import { errorHandler, jsonNotFoundHandler } from '@/shared/errors.js';

const GLOBAL_RATE_LIMIT_MAX = 300;
const GLOBAL_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX = 20;
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const JSON_BODY_LIMIT = '1mb';

export const API_V1_PREFIX = '/api/v1';

// Ops/infra surfaces stay unversioned; only the product API is versioned.
const UNVERSIONED_PATHS = ['/health', '/metrics', '/debug', '/openapi', '/swagger'];

function shouldLogRequest(url: string | undefined): boolean {
    if (!url) return false;
    const path = url.split('?')[0];
    return !UNVERSIONED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface CreateAppOptions {
    /** Lazily resolved queues to render on Bull Board alongside the preview queue. */
    bullBoardQueues?: () => Queue[]
}

export function createApp(runtime: AppRuntime, options: CreateAppOptions = {}) {
    const app = express();

    app.disable('x-powered-by');
    app.set('trust proxy', 1);

    // Access log + correlation id. Honors an inbound x-request-id so traces can
    // be continued across nginx/websocket hops; always echoes it back.
    app.use(pinoHttp({
        logger,
        genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const requestId = typeof incoming === 'string' && /^[\w.@-]{8,128}$/.test(incoming)
                ? incoming
                : randomUUID();
            res.setHeader('x-request-id', requestId);
            return requestId;
        },
        autoLogging: {
            ignore: (req) => !shouldLogRequest(req.url),
        },
        customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
        },
    }));

    app.use(helmet());
    app.use(createCorsMiddleware(runtime.config.corsOrigin));
    app.use(cookieParser());

    const rateLimitSendCommand: SendCommandFn = (...args: string[]) =>
        runtime.redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>;

    // express-rate-limit forbids sharing one store instance between
    // limiters (ERR_ERL_STORE_REUSE), and distinct prefixes keep counter
    // keys from colliding — otherwise the auth limiter and the global
    // limiter would drain each other's budgets.
    function createRateLimitStore(prefix: string): RedisStore | undefined {
        return runtime.config.hasRedisUrl
            ? new RedisStore({
                prefix,
                sendCommand: rateLimitSendCommand,
            })
            : undefined;
    }

    const globalRateLimitStore = createRateLimitStore('rl:');
    const authRateLimitStore = createRateLimitStore('rl:auth:');

    const globalLimiter = rateLimit({
        windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
        limit: GLOBAL_RATE_LIMIT_MAX,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        // Availability over strictness: never 500 the whole API because the
        // counters are unreachable.
        passOnStoreError: true,
        ...(globalRateLimitStore ? { store: globalRateLimitStore } : {}),
        skip: (req) => UNVERSIONED_PATHS.some((prefix) =>
            req.path === prefix || req.path.startsWith(`${prefix}/`)),
    });
    const authLimiter = rateLimit({
        windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
        limit: AUTH_RATE_LIMIT_MAX,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        passOnStoreError: true,
        ...(authRateLimitStore ? { store: authRateLimitStore } : {}),
    });

    app.use(globalLimiter);

    // Stripe webhook must see the raw body, so it stays before express.json().
    // It also stays unversioned: the URL is registered in the Stripe dashboard.
    app.use('/', createBillingWebhookRouter(runtime.billingService));
    app.use(express.json({ limit: JSON_BODY_LIMIT }));

    app.get('/health/live', livenessRoute);
    app.get('/health/ready', healthRoute(runtime.db, runtime.redis));
    // Back-compat alias used by Docker HEALTHCHECK and existing probes.
    app.get('/health', healthRoute(runtime.db, runtime.redis));
    app.get('/metrics', createMetricsRoute(runtime.metrics));

    if (runtime.config.enableBullBoard) {
        const { bullBoardUsername, bullBoardPassword, nodeEnv } = runtime.config;
        const queues = () => [
            runtime.previewJobService.getQueue(),
            ...(options.bullBoardQueues?.() ?? []),
        ];
        if (bullBoardPassword) {
            app.use(
                BULL_BOARD_BASE_PATH,
                createBasicAuthGate(bullBoardUsername, bullBoardPassword),
                createBullBoardRouter(queues()),
            );
        } else if (nodeEnv === 'production') {
            logger.error('[BullBoard] enabled in production without BULL_BOARD_PASSWORD — refusing to mount');
        } else {
            logger.warn('[BullBoard] mounted WITHOUT auth: set BULL_BOARD_PASSWORD to lock it down');
            app.use(BULL_BOARD_BASE_PATH, createBullBoardRouter(queues()));
        }
    }
    app.use('/debug', createDebugRouter(runtime));
    app.use('/', createOpenApiRouter(runtime.config));
    app.use('/swagger', createSwaggerRouter(runtime.config));

    const boardDeps = {
        boardService: runtime.boardService,
        workspaceService: runtime.workspaceService,
        authMiddleware: runtime.authMiddleware,
        boardStateService: runtime.boardStateService,
        mutationProcessor: runtime.mutationProcessor,
        authService: runtime.authService,
        previewJobService: runtime.previewJobService,
        events: runtime.events,
    };

    function mountModuleRouters(parent: express.Router) {
        parent.use('/auth', authLimiter, createAuthRouter(
            runtime.config,
            runtime.authService,
            runtime.userService,
            runtime.db,
        ));
        parent.use('/users', createUserRouter(runtime.userService, runtime.authMiddleware));
        parent.use('/', createBillingRouter(runtime.billingService, runtime.authMiddleware));
        parent.use('/', createWorkspaceRouter(runtime.workspaceService, runtime.authMiddleware));
        parent.use('/', createBoardRouter(boardDeps));
    }

    const apiV1 = express.Router();
    mountModuleRouters(apiV1);
    app.use(API_V1_PREFIX, apiV1);

    if (runtime.config.enableLegacyApiRoutes) {
        logger.info('[API] legacy unversioned routes enabled (ENABLE_LEGACY_API_ROUTES=true)');
        mountModuleRouters(app);
    }

    app.use(jsonNotFoundHandler);
    app.use(errorHandler);

    return app;
}
