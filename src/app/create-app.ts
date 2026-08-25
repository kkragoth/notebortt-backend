import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { RedisStore } from 'rate-limit-redis';
import type { RedisReply, SendCommandFn } from 'rate-limit-redis';
import type { AppRuntime } from '@/app/runtime.js';
import { createCorsMiddleware, parseAllowedOrigins } from '@/shared/cors.js';
import { logger } from '@/shared/logger.js';
import { createAuthRouter } from '@/modules/auth/index.js';
import { createUserRouter } from '@/modules/users/index.js';
import { createWorkspaceRouter } from '@/modules/workspaces/index.js';
import { createBoardRouter } from '@/modules/boards/index.js';
import { createBillingRouter, createBillingWebhookRouter } from '@/modules/billing/index.js';
import { createDebugRouter } from '@/app/debug.routes.js';
import { healthRoute, livenessRoute } from '@/app/health.routes.js';
import { createMetricsRoute } from '@/app/metrics.routes.js';
import { createOpenApiRouter } from '@/app/openapi.routes.js';
import { createSwaggerRouter } from '@/app/swagger.routes.js';
import { errorHandler, jsonNotFoundHandler } from '@/shared/errors.js';

const GLOBAL_RATE_LIMIT_MAX = 300;
const GLOBAL_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX = 20;
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
// Generous on purpose: orchestrator probes (15s HEALTHCHECK cadence) must
// never be throttled, while abusive loops stay bounded.
const PROBE_RATE_LIMIT_MAX = 240;
const PROBE_RATE_LIMIT_WINDOW_MS = 60_000;
const JSON_BODY_LIMIT = '1mb';

export const API_V1_PREFIX = '/api/v1';

// Ops/infra surfaces stay unversioned; only the product API is versioned.
const UNVERSIONED_PATHS = ['/health', '/metrics', '/debug', '/openapi', '/swagger'];

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function shouldLogRequest(url: string | undefined): boolean {
    if (!url) return false;
    const path = url.split('?')[0];
    return !UNVERSIONED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function createApp(runtime: AppRuntime) {
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

    // Bench/load-test escape hatch (RATE_LIMIT_DISABLED): skip both limiters
    // entirely instead of tuning budgets, so production limits stay honest.
    const rateLimitingEnabled = !runtime.config.rateLimitDisabled;

    const globalRateLimitStore = createRateLimitStore('rl:');
    const authRateLimitStore = createRateLimitStore('rl:auth:');
    const probeRateLimitStore = createRateLimitStore('rl:probe:');

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
    const probeLimiter = rateLimit({
        windowMs: PROBE_RATE_LIMIT_WINDOW_MS,
        limit: PROBE_RATE_LIMIT_MAX,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        passOnStoreError: true,
        ...(probeRateLimitStore ? { store: probeRateLimitStore } : {}),
    });

    // CSRF defense-in-depth for cookie-authenticated state changes: browsers
    // always attach Origin on cross-site POST/PUT/PATCH/DELETE, so a forged
    // request from a foreign origin is rejected even if cookies ride along.
    // Non-browser clients (curl, probes) send no Origin and pass through.
    const originCheck = (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const origin = req.headers.origin;
        if (origin !== undefined && STATE_CHANGING_METHODS.has(req.method)) {
            const allowedOrigins = parseAllowedOrigins(runtime.config.corsOrigin);
            if (!allowedOrigins.includes(origin)) {
                res.status(403).json({ error: 'Untrusted origin' });
                return;
            }
        }
        next();
    };
    app.use(originCheck);

    if (rateLimitingEnabled) {
        app.use(globalLimiter);
    }

    // Stripe webhook must see the raw body, so it stays before express.json().
    // It also stays unversioned: the URL is registered in the Stripe dashboard.
    app.use('/', createBillingWebhookRouter(runtime.billingService));
    app.use(express.json({ limit: JSON_BODY_LIMIT }));

    const probeGuards = rateLimitingEnabled ? [probeLimiter] : [];
    app.get('/health/live', ...probeGuards, livenessRoute);
    app.get('/health/ready', ...probeGuards, healthRoute(runtime.db, runtime.redis));
    // Back-compat alias used by Docker HEALTHCHECK and existing probes.
    app.get('/health', ...probeGuards, healthRoute(runtime.db, runtime.redis));
    app.get('/metrics', ...probeGuards, createMetricsRoute(runtime.metrics));

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
        parent.use('/auth', ...(rateLimitingEnabled ? [authLimiter] : []), createAuthRouter(
            runtime.config,
            runtime.authService,
            runtime.userService,
            runtime.db,
            runtime.metrics,
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
        // P3 gate input: measures real production reliance on the unversioned
        // surface before the default flips to false.
        app.use((req, res, next) => {
            runtime.metrics.incrementCounter('legacy_requests_total');
            next();
        });
        mountModuleRouters(app);
    }

    app.use(jsonNotFoundHandler);
    app.use(errorHandler);

    return app;
}
