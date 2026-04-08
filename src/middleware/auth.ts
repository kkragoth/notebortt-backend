import type { Request, Response, NextFunction } from 'express'
import type { AuthService } from '../services/auth.service.js'

const ACCESS_TOKEN_COOKIE_NAME = 'accessToken'

function readAccessToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    return header.slice(7)
  }

  const cookieToken = req.cookies?.[ACCESS_TOKEN_COOKIE_NAME]
  return typeof cookieToken === 'string' && cookieToken.length > 0 ? cookieToken : null
}

export function createAuthMiddleware(authService: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readAccessToken(req)
    if (!token) {
      res.status(401).json({ error: 'Missing authentication token' })
      return
    }

    try {
      const payload = authService.verifyAccessToken(token)
      req.userId = payload.sub
      next()
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' })
    }
  }
}
