import { z } from 'zod';

const envSchema = z.object({
    DATABASE_URL: z.string().refine(
        (s) => s.startsWith('postgres://') || s.startsWith('postgresql://'),
        { message: 'Must be a valid PostgreSQL connection string' }
    ),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).default(20),
    DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(5),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
    REDIS_URL: z.string().optional(),
    REDIS_REALTIME_URL: z.string().optional(),
    REDIS_JOBS_URL: z.string().optional(),
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_REDIRECT_URI: z.string(),
    JWT_SECRET: z.string().min(16),
    JWT_EXPIRES_IN: z.string().default('15m'),
    REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().default(7),
    ENABLE_INCREMENTAL_PERSISTENCE: z.coerce.boolean().default(true),
    ENABLE_TARGETED_MUTATION_READS: z.coerce.boolean().default(true),
    PRESENCE_WRITE_THROTTLE_MS: z.coerce.number().int().min(0).default(3000),
    PRESENCE_WRITE_JITTER_MS: z.coerce.number().int().min(0).default(400),
    ENABLE_CLEANUP_ACTIVE_INDEX: z.coerce.boolean().default(true),
    EVENT_BUS_MODE: z.enum(['local', 'stream']).default('local'),
    BOARD_PERSIST_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
    REDIS_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(120_000),
    ENABLE_BULL_BOARD: z.enum(['true', 'false']).optional(),
    ENABLE_LEGACY_API_ROUTES: z.coerce.boolean().default(true),
    // DEPRECATED: tokens in the OAuth redirect fragment leak via history and
    // extensions. Cookies are already set; flip to false once the frontend
    // stops reading location.hash on /callback.
    ENABLE_OAUTH_FRAGMENT_TOKENS: z.coerce.boolean().default(true),
    BULL_BOARD_USERNAME: z.string().min(1).default('admin'),
    BULL_BOARD_PASSWORD: z.string().min(8).optional(),
    STRIPE_BILLING_ENABLED: z.coerce.boolean().default(false),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_PRICE_STARTUP: z.string().optional(),
    STRIPE_PRICE_BUSINESS: z.string().optional(),
    STRIPE_CHECKOUT_SUCCESS_URL: z.string().optional(),
    STRIPE_CHECKOUT_CANCEL_URL: z.string().optional(),
    STRIPE_PORTAL_RETURN_URL: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
});

export interface AppConfig {
  databaseUrl: string
  dbPoolMax: number
  dbIdleTimeoutSeconds: number
  dbConnectTimeoutSeconds: number
  dbStatementTimeoutMs: number
  hasRedisUrl: boolean
  redisRealtimeUrl: string
  redisJobsUrl: string
  port: number
  nodeEnv: 'development' | 'production' | 'test'
  corsOrigin: string
  googleClientId: string
  googleClientSecret: string
  googleRedirectUri: string
  jwtSecret: string
  jwtExpiresIn: string
  refreshTokenExpiresDays: number
  enableIncrementalPersistence: boolean
  enableTargetedMutationReads: boolean
  presenceWriteThrottleMs: number
  presenceWriteJitterMs: number
  enableCleanupActiveIndex: boolean
  eventBusStreamEnabled: boolean
  boardPersistIntervalMs: number
  redisCleanupIntervalMs: number
  enableBullBoard: boolean
  enableLegacyApiRoutes: boolean
  enableOauthFragmentTokens: boolean
  bullBoardUsername: string
  bullBoardPassword: string | null
  stripeBillingEnabled: boolean
  stripeSecretKey: string | null
  stripePriceStartup: string | null
  stripePriceBusiness: string | null
  stripeCheckoutSuccessUrl: string | null
  stripeCheckoutCancelUrl: string | null
  stripePortalReturnUrl: string | null
  stripeWebhookSecret: string | null
}

export function loadConfig(): AppConfig {
    const parsed = envSchema.parse(process.env);
    const fallbackRedisUrl = parsed.REDIS_URL ?? 'redis://localhost:6379';
    const redisRealtimeUrl = parsed.REDIS_REALTIME_URL ?? fallbackRedisUrl;
    const redisJobsUrl = parsed.REDIS_JOBS_URL ?? fallbackRedisUrl;

    return {
        databaseUrl: parsed.DATABASE_URL,
        dbPoolMax: parsed.DB_POOL_MAX,
        dbIdleTimeoutSeconds: parsed.DB_IDLE_TIMEOUT_SECONDS,
        dbConnectTimeoutSeconds: parsed.DB_CONNECT_TIMEOUT_SECONDS,
        dbStatementTimeoutMs: parsed.DB_STATEMENT_TIMEOUT_MS,
        hasRedisUrl: parsed.REDIS_URL !== undefined,
        redisRealtimeUrl,
        redisJobsUrl,
        port: parsed.PORT,
        nodeEnv: parsed.NODE_ENV,
        corsOrigin: parsed.CORS_ORIGIN,
        googleClientId: parsed.GOOGLE_CLIENT_ID,
        googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
        googleRedirectUri: parsed.GOOGLE_REDIRECT_URI,
        jwtSecret: parsed.JWT_SECRET,
        jwtExpiresIn: parsed.JWT_EXPIRES_IN,
        refreshTokenExpiresDays: parsed.REFRESH_TOKEN_EXPIRES_DAYS,
        enableIncrementalPersistence: parsed.ENABLE_INCREMENTAL_PERSISTENCE,
        enableTargetedMutationReads: parsed.ENABLE_TARGETED_MUTATION_READS,
        presenceWriteThrottleMs: parsed.PRESENCE_WRITE_THROTTLE_MS,
        presenceWriteJitterMs: parsed.PRESENCE_WRITE_JITTER_MS,
        enableCleanupActiveIndex: parsed.ENABLE_CLEANUP_ACTIVE_INDEX,
        eventBusStreamEnabled: parsed.EVENT_BUS_MODE === 'stream',
        boardPersistIntervalMs: parsed.BOARD_PERSIST_INTERVAL_MS,
        redisCleanupIntervalMs: parsed.REDIS_CLEANUP_INTERVAL_MS,
        // Bull Board exposes internal job data; default on outside production.
        enableBullBoard: parsed.ENABLE_BULL_BOARD
            ? parsed.ENABLE_BULL_BOARD === 'true'
            : parsed.NODE_ENV !== 'production',
        enableLegacyApiRoutes: parsed.ENABLE_LEGACY_API_ROUTES,
        enableOauthFragmentTokens: parsed.ENABLE_OAUTH_FRAGMENT_TOKENS,
        bullBoardUsername: parsed.BULL_BOARD_USERNAME,
        bullBoardPassword: parsed.BULL_BOARD_PASSWORD ?? null,
        stripeBillingEnabled: parsed.STRIPE_BILLING_ENABLED,
        stripeSecretKey: parsed.STRIPE_SECRET_KEY ?? null,
        stripePriceStartup: parsed.STRIPE_PRICE_STARTUP ?? null,
        stripePriceBusiness: parsed.STRIPE_PRICE_BUSINESS ?? null,
        stripeCheckoutSuccessUrl: parsed.STRIPE_CHECKOUT_SUCCESS_URL ?? null,
        stripeCheckoutCancelUrl: parsed.STRIPE_CHECKOUT_CANCEL_URL ?? null,
        stripePortalReturnUrl: parsed.STRIPE_PORTAL_RETURN_URL ?? null,
        stripeWebhookSecret: parsed.STRIPE_WEBHOOK_SECRET ?? null,
    };
}
