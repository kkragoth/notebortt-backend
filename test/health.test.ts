import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { healthRoute } from '../src/routes/health.js'
import { resetOpenSocketIoConnectionsForTests } from '../src/socketio/stats.js'

function createApp(mockDb: any, mockRedis: any) {
  const app = express()
  app.get('/health', healthRoute(mockDb, mockRedis))
  return app
}

describe('GET /health', () => {
  it('returns status ok with postgres and redis status', async () => {
    resetOpenSocketIoConnectionsForTests()
    const mockDb = { execute: async () => [{ now: new Date() }] } as any
    const mockRedis = {
      ping: async () => 'PONG',
      zcard: async () => 0,
      zrevrange: async () => [],
    } as any
    const res = await request(createApp(mockDb, mockRedis)).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.postgres).toBe('ok')
    expect(res.body.redis).toBe('ok')
    expect(res.body).toHaveProperty('uptime')
    expect(res.body.openWebSocketConnections).toBe(0)
    expect(res.body.boardState).toEqual({
      dirtyBacklog: 0,
      lastDirtyAt: null,
      timeSinceLastDirtyMs: null,
    })
  })

  it('returns degraded when postgres is down', async () => {
    resetOpenSocketIoConnectionsForTests()
    const mockDb = { execute: async () => { throw new Error('connection refused') } } as any
    const mockRedis = {
      ping: async () => 'PONG',
      zcard: async () => 0,
      zrevrange: async () => [],
    } as any
    const res = await request(createApp(mockDb, mockRedis)).get('/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('degraded')
    expect(res.body.postgres).toBe('error')
    expect(res.body.redis).toBe('ok')
    expect(res.body.openWebSocketConnections).toBe(0)
  })

  it('degrades gracefully when backlog metrics are unavailable', async () => {
    resetOpenSocketIoConnectionsForTests()
    const mockDb = { execute: async () => [{ now: new Date() }] } as any
    const mockRedis = { ping: async () => 'PONG' } as any
    const res = await request(createApp(mockDb, mockRedis)).get('/health')
    expect(res.status).toBe(503)
    expect(res.body.status).toBe('degraded')
    expect(res.body.postgres).toBe('ok')
    expect(res.body.redis).toBe('ok')
    expect(res.body.boardState).toEqual({
      dirtyBacklog: 0,
      lastDirtyAt: null,
      timeSinceLastDirtyMs: null,
    })
  })
})
