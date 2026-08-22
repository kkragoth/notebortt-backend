import { z } from 'zod';

const envSchema = z.object({
    DATABASE_URL: z.string().refine(
        (s) => s.startsWith('postgres://') || s.startsWith('postgresql://'),
        { message: 'Must be a valid PostgreSQL connection string' }
    ),
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
