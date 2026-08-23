import { ACCESS_TOKEN_COOKIE_NAME } from '../socketio/constants.js';
import type { SocketIdentity, SocketIoRealtimeDependencies } from '../socketio/types.js';

function parseCookieHeader(raw: string | undefined): Record<string, string> {
    if (!raw) {
        return {};
    }

    const cookies: Record<string, string> = {};
    for (const segment of raw.split(';')) {
        const [name, ...rest] = segment.trim().split('=');
        if (!name || rest.length === 0) {
            continue;
        }
        cookies[name] = decodeURIComponent(rest.join('='));
    }
    return cookies;
}

export async function resolveSocketIdentity(socket: any, deps: SocketIoRealtimeDependencies): Promise<SocketIdentity> {
    const headers = socket.request?.headers ?? {};
    const cookies = parseCookieHeader(headers.cookie as string | undefined);
    const cookieToken = cookies[ACCESS_TOKEN_COOKIE_NAME];
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
