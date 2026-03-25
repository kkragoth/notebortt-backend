import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createAuthMiddleware } from '../src/middleware/auth.js'

const mockAuthService = {
  verifyAccessToken: (token: string) => {
    if (token === 'valid-token') return { sub: 'user-123' }
    throw new Error('invalid')
  },
} as any

describe('auth middleware', () => {
  const authMiddleware = createAuthMiddleware(mockAuthService)

  function createApp() {
    const app = express()
    app.get('/protected', authMiddleware, (req, res) => {
      res.json({ userId: req.userId })
    })
    return app
  }

  it('passes with valid Bearer token', async () => {
    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', 'Bearer valid-token')
    expect(res.status).toBe(200)
    expect(res.body.userId).toBe('user-123')
  })

  it('rejects request without Authorization header', async () => {
    const res = await request(createApp()).get('/protected')
    expect(res.status).toBe(401)
  })

  it('rejects request with invalid token', async () => {
    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', 'Bearer bad-token')
    expect(res.status).toBe(401)
  })

  it('rejects request with non-Bearer scheme', async () => {
    const res = await request(createApp())
      .get('/protected')
      .set('Authorization', 'Basic abc123')
    expect(res.status).toBe(401)
  })
})
