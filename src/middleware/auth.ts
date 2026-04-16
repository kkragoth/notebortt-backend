import type { Request, Response, NextFunction } from 'express'
import { fromNodeHeaders } from 'better-auth/node'
import type { AuthService } from '../services/auth.service.js'

const ACCESS_TOKEN_COOKIE_NAME = 'accessToken'
type BetterAuthSessionResolver = (headers: Headers) => Promise<{ userId: string } | null>

function readAccessTokenFromCookieHeader(rawCookieHeader: string | undefined): string | null {
  if (!rawCookieHeader) {
    return null
  }

  for (const part of rawCookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.split('=')
    if (!rawKey || rawValue.length === 0) {
      continue
    }
    if (rawKey.trim() !== ACCESS_TOKEN_COOKIE_NAME) {
      continue
    }
    const value = rawValue.join('=').trim()
    return value.length > 0 ? decodeURIComponent(value) : null
  }

  return null
}

function readAccessToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    return header.slice(7)
  }

  const cookieToken = req.cookies?.[ACCESS_TOKEN_COOKIE_NAME]
  if (typeof cookieToken === 'string' && cookieToken.length > 0) {
    return cookieToken
  }

  const rawCookieHeader = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie
  return readAccessTokenFromCookieHeader(rawCookieHeader)
}

export function createAuthMiddleware(
  authService: AuthService,
  resolveBetterAuthSession: BetterAuthSessionResolver | null = null,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readAccessToken(req)
    if (token) {
      try {
        const payload = authService.verifyAccessToken(token)
        req.userId = payload.sub
        next()
        return
      } catch {
        // Fall through to Better Auth session resolution.
      }
    }

    if (resolveBetterAuthSession) {
      try {
        const session = await resolveBetterAuthSession(fromNodeHeaders(req.headers))
        if (session?.userId) {
          req.userId = session.userId
          next()
          return
        }
      } catch {
        // Ignore Better Auth resolution errors and return standard 401 below.
      }
    }

    if (token) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }

    res.status(401).json({ error: 'Missing authentication token' })
  }
}
