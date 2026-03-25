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
})

export interface AppConfig {
  databaseUrl: string
  redisUrl: string
  port: number
  nodeEnv: 'development' | 'production' | 'test'
  corsOrigin: string
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    corsOrigin: parsed.CORS_ORIGIN,
  }
}
