import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AuthService } from '../services/auth.service.js'

export function toRecord<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.id, row]))
}

export function getRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function getBoardPermission(value: unknown): 'view' | 'edit' | null {
  if (value === 'view' || value === 'edit') {
    return value
  }

  return null
}

export function sendBadRequest(res: Response, error: string): void {
  res.status(400).json({ error })
}

export function sendForbidden(res: Response, error = 'Forbidden'): void {
  res.status(403).json({ error })
}

export function sendNotFound(res: Response, error: string): void {
  res.status(404).json({ error })
}

export function createOptionalAuth(authService: AuthService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization
    const tokenFromHeader = header?.startsWith('Bearer ') ? header.slice(7) : null
    const tokenFromCookie = typeof req.cookies?.accessToken === 'string' ? req.cookies.accessToken : null
    const token = tokenFromHeader ?? tokenFromCookie

    try {
      if (!token) {
        next()
        return
      }

      const payload = authService.verifyAccessToken(token)
      if (payload.sub) {
        req.userId = payload.sub
      }
    } catch {
      // Ignore invalid token and continue as unauthenticated.
    }

    next()
  }
}
