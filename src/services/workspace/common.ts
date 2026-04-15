import { randomBytes } from 'crypto'

const INVITATION_TOKEN_BYTES = 32
const INVITATION_EXPIRES_DAYS = 7
export const INVITATION_STATUS_PENDING = 'pending'

export function buildInvitationExpiry(): Date {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRES_DAYS)
  return expiresAt
}

export function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString('hex')
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function trimEmail(email: string): string {
  return email.trim()
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === '23505'
}

export class WorkspaceInvitationError extends Error {
  constructor(
    public code: 'not_found' | 'wrong_user' | 'expired_or_used' | 'user_not_found',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceInvitationError'
  }
}
