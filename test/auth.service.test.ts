import { describe, expect, it } from 'vitest';
import { createAuthService } from '@/modules/auth/auth.service.js';

const mockConfig = {
    jwtSecret: 'test-secret-at-least-16-characters',
    jwtExpiresIn: '15m',
} as any;

describe('auth service', () => {
    const authService = createAuthService(mockConfig);

    it('generates and verifies a valid JWT', () => {
        const token = authService.generateAccessToken('user-123');
        const payload = authService.verifyAccessToken(token);
        expect(payload.sub).toBe('user-123');
    });

    it('rejects an invalid token', () => {
        expect(() => authService.verifyAccessToken('invalid-token')).toThrow();
    });

    it('generates a refresh token string', () => {
        const token = authService.generateRefreshToken();
        expect(token).toHaveLength(80); // 40 bytes hex
    });

    it('hashes and verifies a refresh token', async () => {
        const token = authService.generateRefreshToken();
        const hash = await authService.hashRefreshToken(token);
        expect(hash).not.toBe(token);
        const valid = await authService.verifyRefreshToken(token, hash);
        expect(valid).toBe(true);
    });

    it('rejects wrong refresh token', async () => {
        const token = authService.generateRefreshToken();
        const hash = await authService.hashRefreshToken(token);
        const valid = await authService.verifyRefreshToken('wrong-token', hash);
        expect(valid).toBe(false);
    });
});

describe('access token algorithm pinning', () => {
    it('rejects tokens signed with a different algorithm (alg confusion)', async () => {
        const { default: jwt } = await import('jsonwebtoken');
        const service = createAuthService({ jwtSecret: 'test-secret-at-least-16-chars', jwtExpiresIn: '15m' });

        // Forged as "none" alg — classic confusion payload.
        const forged = jwt.sign({ sub: 'user-1' }, 'test-secret-at-least-16-chars', { algorithm: 'none' });
        expect(() => service.verifyAccessToken(forged)).toThrow();

        const legit = service.generateAccessToken('user-1');
        expect(service.verifyAccessToken(legit).sub).toBe('user-1');
    });
});
