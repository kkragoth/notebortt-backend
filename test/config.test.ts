import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('config', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
    process.env.REDIS_URL = 'redis://localhost:6379'
    process.env.PORT = '3000'
    process.env.NODE_ENV = 'development'
    process.env.CORS_ORIGIN = 'http://localhost:5173'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('parses valid environment variables', () => {
    const config = loadConfig()
    expect(config.port).toBe(3000)
    expect(config.databaseUrl).toBe('postgres://test:test@localhost:5432/test')
    expect(config.redisUrl).toBe('redis://localhost:6379')
    expect(config.corsOrigin).toBe('http://localhost:5173')
  })

  it('throws on missing DATABASE_URL', () => {
    delete process.env.DATABASE_URL
    expect(() => loadConfig()).toThrow()
  })

  it('defaults PORT to 3000', () => {
    delete process.env.PORT
    const config = loadConfig()
    expect(config.port).toBe(3000)
  })
})
