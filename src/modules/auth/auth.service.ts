import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type {SignOptions} from 'jsonwebtoken';
import type { AppConfig } from '@/shared/config.js';

const JWT_ALGORITHM = 'HS256';

export function createAuthService(config: Pick<AppConfig, 'jwtSecret' | 'jwtExpiresIn'>) {
    function generateAccessToken(userId: string): string {
        const signOptions: SignOptions = {
            expiresIn: config.jwtExpiresIn as SignOptions['expiresIn'],
            algorithm: JWT_ALGORITHM,
        };
        return jwt.sign({ sub: userId }, config.jwtSecret, signOptions);
    }

    function verifyAccessToken(token: string): { sub: string } {
        // Explicit algorithm pinning: without it, jsonwebtoken accepts any
        // alg the token claims, enabling alg-confusion forgeries.
        return jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] }) as { sub: string };
    }

    function generateRefreshToken(): string {
        return crypto.randomBytes(40).toString('hex');
    }

    function hashRefreshToken(token: string): string {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    function verifyRefreshToken(token: string, hash: string): boolean {
        return hashRefreshToken(token) === hash;
    }

    return { generateAccessToken, verifyAccessToken, generateRefreshToken, hashRefreshToken, verifyRefreshToken };
}

export type AuthService = ReturnType<typeof createAuthService>
