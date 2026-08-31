import { randomBytes } from 'node:crypto';

const INVITATION_TOKEN_BYTES = 32;
const LINK_SHARE_TOKEN_BYTES = 24;
const INVITATION_EXPIRES_DAYS = 7;
const POSTGRES_UNDEFINED_TABLE = '42P01';
const POSTGRES_UNIQUE_VIOLATION = '23505';

export function isMissingRelationError(error: unknown): boolean {
    return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === POSTGRES_UNDEFINED_TABLE;
}

export function isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION;
}

export function buildInvitationExpiry(): Date {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRES_DAYS);
    return expiresAt;
}

export function generateInvitationToken(): string {
    return randomBytes(INVITATION_TOKEN_BYTES).toString('hex');
}

export function generateLinkShareToken(): string {
    return randomBytes(LINK_SHARE_TOKEN_BYTES).toString('hex');
}

/** Shape of every link-share token issued by this service (24-byte hex). */
export const LINK_SHARE_TOKEN_PATTERN = /^[0-9a-f]{48}$/;

export function isValidLinkShareToken(value: unknown): value is string {
    return typeof value === 'string' && LINK_SHARE_TOKEN_PATTERN.test(value);
}
