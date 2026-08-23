import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuthService } from './/auth.service.js';

const TEST_CONFIG = {
    jwtSecret: 'test-secret-that-is-long-enough-16',
    jwtExpiresIn: '15m',
};

describe('AuthService', () => {
    const authService = createAuthService(TEST_CONFIG);

    describe('generateAccessToken / verifyAccessToken', () => {
        it('generates a token that can be verified', () => {
            const token = authService.generateAccessToken('user-123');
            const payload = authService.verifyAccessToken(token);
            expect(payload.sub).toBe('user-123');
        });

        it('throws on an invalid token', () => {
            expect(() => authService.verifyAccessToken('not-a-valid-token')).toThrow();
        });
    });

    describe('generateRefreshToken', () => {
        it('generates a 80-char hex string', () => {
            const token = authService.generateRefreshToken();
            expect(token).toMatch(/^[0-9a-f]{80}$/);
        });

        it('generates unique tokens each call', () => {
            const a = authService.generateRefreshToken();
            const b = authService.generateRefreshToken();
            expect(a).not.toBe(b);
        });
    });

    describe('hashRefreshToken / verifyRefreshToken', () => {
        it('returns a sha256 hex hash', () => {
            const token = 'some-random-token';
            const hash = authService.hashRefreshToken(token);
            const expected = crypto.createHash('sha256').update(token).digest('hex');
            expect(hash).toBe(expected);
        });

        it('verifyRefreshToken returns true for matching token and hash', () => {
            const token = authService.generateRefreshToken();
            const hash = authService.hashRefreshToken(token);
            expect(authService.verifyRefreshToken(token, hash)).toBe(true);
        });

        it('verifyRefreshToken returns false for wrong token', () => {
            const token = authService.generateRefreshToken();
            const hash = authService.hashRefreshToken(token);
            expect(authService.verifyRefreshToken('wrong-token', hash)).toBe(false);
        });

        it('hashRefreshToken is deterministic', () => {
            const token = 'fixed-token';
            expect(authService.hashRefreshToken(token)).toBe(authService.hashRefreshToken(token));
        });
    });
});
