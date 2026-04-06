import { Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import { eq, and, gt } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { sendBadRequest, sendNotFound } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import { authCallbackQuerySchema, devLoginBodySchema } from '../openapi/schemas.js'
import type { AuthService } from '../services/auth.service.js'
import type { UserService } from '../services/user.service.js'
import type { Database } from '../db/client.js'
import { refreshTokens } from '../db/schema.js'

const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile']
const REFRESH_TOKEN_COOKIE_NAME = 'refreshToken'
const REFRESH_TOKEN_COOKIE_PATH = '/auth'

function buildRefreshTokenCookieOptions(config: Pick<AppConfig, 'nodeEnv' | 'refreshTokenExpiresDays'>) {
  const maxAgeMs = config.refreshTokenExpiresDays * 24 * 60 * 60 * 1000
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    maxAge: maxAgeMs,
    path: REFRESH_TOKEN_COOKIE_PATH,
  }
}

function buildRefreshTokenExpiry(refreshTokenExpiresDays: number): Date {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + refreshTokenExpiresDays)
  return expiresAt
}

function extractGoogleUserInfo(payload: { email?: string; name?: string; picture?: string; sub?: string }) {
  const email = payload.email ?? ''
  const name = payload.name ?? ''
  const avatarUrl = payload.picture ?? null
  const googleId = payload.sub ?? ''
  return { email, name, avatarUrl, googleId }
}

export function createAuthRouter(
  config: Pick<AppConfig, 'googleClientId' | 'googleClientSecret' | 'googleRedirectUri' | 'nodeEnv' | 'refreshTokenExpiresDays' | 'corsOrigin'>,
  authService: AuthService,
  userService: UserService,
  db: Database,
) {
  const router = Router()
  const oauth2Client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri)

  router.get('/google', (_req, res) => {
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GOOGLE_OAUTH_SCOPES,
    })
    res.redirect(url)
  })

  router.get('/callback', async (req, res) => {
    const parsed = parseWithSchema(authCallbackQuerySchema, req.query)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    try {
      const { tokens } = await oauth2Client.getToken(parsed.data.code)
      const idToken = tokens.id_token

      if (!idToken) {
        res.status(400).json({ error: 'Missing id_token from Google' })
        return
      }

      const ticket = await oauth2Client.verifyIdToken({ idToken, audience: config.googleClientId })
      const payload = ticket.getPayload()

      if (!payload) {
        res.status(400).json({ error: 'Invalid Google token payload' })
        return
      }

      const { email, name, avatarUrl, googleId } = extractGoogleUserInfo(payload)
      const user = await userService.upsertGoogleUser({ email, name, avatarUrl, googleId })

      const accessToken = authService.generateAccessToken(user.id)
      const refreshToken = authService.generateRefreshToken()
      const tokenHash = authService.hashRefreshToken(refreshToken)
      const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays)

      await db.insert(refreshTokens).values({ userId: user.id, tokenHash, expiresAt })

      const cookieOptions = buildRefreshTokenCookieOptions(config)
      res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, cookieOptions)
      const redirectUrl = new URL('/callback', config.corsOrigin)
      redirectUrl.searchParams.set('accessToken', accessToken)
      res.redirect(redirectUrl.toString())
    } catch (err) {
      console.error('[Auth] OAuth callback error:', err)
      res.status(500).json({ error: 'Authentication failed' })
    }
  })

  router.post('/refresh', async (req, res) => {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE_NAME] as string | undefined

    if (!refreshToken) {
      res.status(401).json({ error: 'Missing refresh token' })
      return
    }

    const tokenHash = authService.hashRefreshToken(refreshToken)
    const now = new Date()

    const found = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), gt(refreshTokens.expiresAt, now)))
      .limit(1)

    if (found.length === 0) {
      const cookieOptions = buildRefreshTokenCookieOptions(config)
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH })
      res.status(401).json({ error: 'Invalid or expired refresh token' })
      return
    }

    const existingToken = found[0]

    await db.delete(refreshTokens).where(eq(refreshTokens.id, existingToken.id))

    const newAccessToken = authService.generateAccessToken(existingToken.userId)
    const newRefreshToken = authService.generateRefreshToken()
    const newTokenHash = authService.hashRefreshToken(newRefreshToken)
    const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays)

    await db.insert(refreshTokens).values({ userId: existingToken.userId, tokenHash: newTokenHash, expiresAt })

    const cookieOptions = buildRefreshTokenCookieOptions(config)
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, newRefreshToken, cookieOptions)
    res.json({ accessToken: newAccessToken })
  })

  router.post('/dev-login', async (req, res) => {
    if (config.nodeEnv !== 'development') {
      sendNotFound(res, 'Not found')
      return
    }

    const parsed = parseWithSchema(devLoginBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const user = await userService.getUserByEmail(parsed.data.email)
    if (!user) {
      sendNotFound(res, 'User not found. Run: just db-seed')
      return
    }

    const accessToken = authService.generateAccessToken(user.id)
    const refreshToken = authService.generateRefreshToken()
    const tokenHash = authService.hashRefreshToken(refreshToken)
    const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays)

    await db.insert(refreshTokens).values({ userId: user.id, tokenHash, expiresAt })

    const cookieOptions = buildRefreshTokenCookieOptions(config)
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, cookieOptions)
    res.json({ accessToken, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } })
  })

  router.post('/logout', async (req, res) => {
    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE_NAME] as string | undefined

    if (refreshToken) {
      const tokenHash = authService.hashRefreshToken(refreshToken)
      await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash))
    }

    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH })
    res.sendStatus(200)
  })

  return router
}
