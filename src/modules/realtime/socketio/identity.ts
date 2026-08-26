import type { Socket } from 'socket.io';
import type { SocketIdentity, SocketIoRealtimeDependencies } from '../socketio/types.js';
import { ACCESS_TOKEN_COOKIE_NAMES } from '@/modules/auth/index.js';
import { parseCookieHeader } from '@/shared/cookies.js';

function readCookieToken(cookies: Record<string, string>): string | undefined {
    for (const name of ACCESS_TOKEN_COOKIE_NAMES) {
        const token = cookies[name];
        if (token) {
            return token;
        }
    }
    return undefined;
}

export async function resolveSocketIdentity(socket: Socket, deps: SocketIoRealtimeDependencies): Promise<SocketIdentity> {
    const headers = socket.request?.headers ?? {};
    const cookies = parseCookieHeader(headers.cookie);
    const cookieToken = readCookieToken(cookies);
    const authHeader = typeof headers.authorization === 'string' ? headers.authorization : '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const authToken = (socket.handshake?.auth as { token?: string } | undefined)?.token;

    const tokenSources = [authToken, bearerToken, cookieToken].filter(Boolean) as string[];
    for (const rawToken of tokenSources) {
        try {
            const payload = deps.authService.verifyAccessToken(rawToken);
            const user = await deps.userService.getUserById(payload.sub);
            if (user) {
                return {
                    authUserId: user.id,
                    runtimeUserId: user.id,
                    userName: user.name,
                    avatarUrl: user.avatarUrl ?? null,
                };
            }
        } catch {
            continue;
        }
    }

    return {
        authUserId: undefined,
        runtimeUserId: `anonymous:${socket.id}`,
        userName: 'Guest',
        avatarUrl: null,
    };
}
