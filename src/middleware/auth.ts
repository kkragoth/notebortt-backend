import type { Request, Response, NextFunction } from 'express'
import type { AuthService } from '../services/auth.service.js'

export function createAuthMiddleware(authService: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid authorization header' })
      return
    }

    const token = header.slice(7)

    try {
      const payload = authService.verifyAccessToken(token)
      req.userId = payload.sub
      next()
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' })
    }
  }
}
