import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import type { AppConfig } from '../config.js'

export function createAuthService(config: Pick<AppConfig, 'jwtSecret' | 'jwtExpiresIn'>) {
  function generateAccessToken(userId: string): string {
    return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn })
  }

  function verifyAccessToken(token: string): { sub: string } {
    return jwt.verify(token, config.jwtSecret) as { sub: string }
  }

  function generateRefreshToken(): string {
    return crypto.randomBytes(40).toString('hex')
  }

  function hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  function verifyRefreshToken(token: string, hash: string): boolean {
    return hashRefreshToken(token) === hash
  }

  return { generateAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken, verifyRefreshToken }
}

export type AuthService = ReturnType<typeof createAuthService>
