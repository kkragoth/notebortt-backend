import { createHash, randomBytes } from 'crypto'
import { Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import { and, eq, gt } from 'drizzle-orm'
import type { AppConfig } from '../config.js'
import { sendBadRequest, sendForbidden, sendNotFound } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import { authCallbackQuerySchema, devLoginBodySchema } from '../openapi/schemas.js'
import type { AuthService } from '../services/auth.service.js'
import type { UserService } from '../services/user.service.js'
import type { Database } from '../db/client.js'
import { refreshTokens } from '../db/schema.js'

const GOOGLE_OAUTH_SCOPES = ['openid', 'email', 'profile']
const ACCESS_TOKEN_COOKIE_NAME = 'accessToken'
const REFRESH_TOKEN_COOKIE_NAME = 'refreshToken'
const REFRESH_TOKEN_COOKIE_PATH = '/auth'
const OAUTH_STATE_COOKIE_NAME = 'oauthState'
const OAUTH_PKCE_COOKIE_NAME = 'oauthPkceVerifier'
const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function isAllowedOrigin(config: Pick<AppConfig, 'corsOrigin'>, origin: string | undefined): boolean {
  if (!origin) {
    return false
  }

  const allowedOrigins = parseAllowedOrigins(config.corsOrigin)
  return allowedOrigins.includes(origin)
}

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

function parseJwtExpiryToMs(raw: string): number {
  const match = raw.match(/^(\d+)([smhd])$/)
  if (!match) {
    return 15 * 60 * 1000
  }

  const amount = Number.parseInt(match[1] ?? '15', 10)
  const unit = match[2] ?? 'm'
  const unitMultiplier: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }

  return amount * (unitMultiplier[unit] ?? unitMultiplier.m)
}

function buildAccessTokenCookieOptions(config: Pick<AppConfig, 'nodeEnv' | 'jwtExpiresIn'>) {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    maxAge: parseJwtExpiryToMs(config.jwtExpiresIn),
    path: '/',
  }
}

function buildOAuthCookieOptions(config: Pick<AppConfig, 'nodeEnv'>) {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax' as const,
    maxAge: OAUTH_COOKIE_MAX_AGE_MS,
    path: '/auth',
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

function generateOAuthState(): string {
  return randomBytes(24).toString('base64url')
}

function generatePkceVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function toPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createAuthRouter(
  config: Pick<AppConfig, 'googleClientId' | 'googleClientSecret' | 'googleRedirectUri' | 'nodeEnv' | 'refreshTokenExpiresDays' | 'jwtExpiresIn' | 'corsOrigin'>,
  authService: AuthService,
  userService: UserService,
  db: Database,
) {
  const router = Router()
  const oauth2Client = new OAuth2Client(config.googleClientId, config.googleClientSecret, config.googleRedirectUri)

  router.get('/google', (_req, res) => {
    const state = generateOAuthState()
    const verifier = generatePkceVerifier()
    const challenge = toPkceChallenge(verifier)
    const oauthCookieOptions = buildOAuthCookieOptions(config)

    res.cookie(OAUTH_STATE_COOKIE_NAME, state, oauthCookieOptions)
    res.cookie(OAUTH_PKCE_COOKIE_NAME, verifier, oauthCookieOptions)

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GOOGLE_OAUTH_SCOPES,
      state,
      code_challenge_method: 'S256' as any,
      code_challenge: challenge,
    })
    res.redirect(url)
  })

  router.get('/callback', async (req, res) => {
    const parsed = parseWithSchema(authCallbackQuerySchema, req.query)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const stateFromCookie = req.cookies[OAUTH_STATE_COOKIE_NAME] as string | undefined
    const verifier = req.cookies[OAUTH_PKCE_COOKIE_NAME] as string | undefined

    if (!stateFromCookie || stateFromCookie !== parsed.data.state || !verifier) {
      res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' })
      res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: '/auth' })
      sendForbidden(res, 'Invalid OAuth state')
      return
    }

    try {
      const { tokens } = await oauth2Client.getToken({
        code: parsed.data.code,
        codeVerifier: verifier,
      })

      const idToken = tokens.id_token
      if (!idToken) {
        sendBadRequest(res, 'Missing id_token from Google')
        return
      }

      const ticket = await oauth2Client.verifyIdToken({ idToken, audience: config.googleClientId })
      const payload = ticket.getPayload()

      if (!payload) {
        sendBadRequest(res, 'Invalid Google token payload')
        return
      }

      const { email, name, avatarUrl, googleId } = extractGoogleUserInfo(payload)
      const user = await userService.upsertGoogleUser({ email, name, avatarUrl, googleId })

      const accessToken = authService.generateAccessToken(user.id)
      const refreshToken = authService.generateRefreshToken()
      const tokenHash = authService.hashRefreshToken(refreshToken)
      const expiresAt = buildRefreshTokenExpiry(config.refreshTokenExpiresDays)

      await db.insert(refreshTokens).values({ userId: user.id, tokenHash, expiresAt })

      const accessCookieOptions = buildAccessTokenCookieOptions(config)
      const refreshCookieOptions = buildRefreshTokenCookieOptions(config)
      res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, accessCookieOptions)
      res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshCookieOptions)
      res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' })
      res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: '/auth' })

      const redirectUrl = new URL('/callback', parseAllowedOrigins(config.corsOrigin)[0] ?? config.corsOrigin)
      res.redirect(redirectUrl.toString())
    } catch (err) {
      console.error('[Auth] OAuth callback error:', err)
      res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/auth' })
      res.clearCookie(OAUTH_PKCE_COOKIE_NAME, { path: '/auth' })
      res.status(500).json({ error: 'Authentication failed' })
    }
  })

  router.post('/refresh', async (req, res) => {
    if (!isAllowedOrigin(config, req.headers.origin)) {
      sendForbidden(res, 'Untrusted origin')
      return
    }

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
      res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH })
      res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' })
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

    const accessCookieOptions = buildAccessTokenCookieOptions(config)
    const refreshCookieOptions = buildRefreshTokenCookieOptions(config)
    res.cookie(ACCESS_TOKEN_COOKIE_NAME, newAccessToken, accessCookieOptions)
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, newRefreshToken, refreshCookieOptions)
    res.json({ ok: true })
  })

  router.post('/dev-login', async (req, res) => {
    if (config.nodeEnv !== 'development') {
      sendNotFound(res, 'Not found')
      return
    }

    if (!isAllowedOrigin(config, req.headers.origin)) {
      sendForbidden(res, 'Untrusted origin')
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

    const accessCookieOptions = buildAccessTokenCookieOptions(config)
    const refreshCookieOptions = buildRefreshTokenCookieOptions(config)
    res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, accessCookieOptions)
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, refreshToken, refreshCookieOptions)
    res.json({ user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl } })
  })

  router.post('/logout', async (req, res) => {
    if (!isAllowedOrigin(config, req.headers.origin)) {
      sendForbidden(res, 'Untrusted origin')
      return
    }

    const refreshToken = req.cookies[REFRESH_TOKEN_COOKIE_NAME] as string | undefined
    if (refreshToken) {
      const tokenHash = authService.hashRefreshToken(refreshToken)
      await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash))
    }

    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_PATH })
    res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' })
    res.sendStatus(200)
  })

  return router
}
