import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().refine(
    (s) => s.startsWith('postgres://') || s.startsWith('postgresql://'),
    { message: 'Must be a valid PostgreSQL connection string' }
  ),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string(),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().default(7),
})

export interface AppConfig {
  databaseUrl: string
  redisUrl: string
  port: number
  nodeEnv: 'development' | 'production' | 'test'
  corsOrigin: string
  googleClientId: string
  googleClientSecret: string
  googleRedirectUri: string
  jwtSecret: string
  jwtExpiresIn: string
  refreshTokenExpiresDays: number
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    corsOrigin: parsed.CORS_ORIGIN,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: parsed.GOOGLE_REDIRECT_URI,
    jwtSecret: parsed.JWT_SECRET,
    jwtExpiresIn: parsed.JWT_EXPIRES_IN,
    refreshTokenExpiresDays: parsed.REFRESH_TOKEN_EXPIRES_DAYS,
  }
}
