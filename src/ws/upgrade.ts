import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import type { AuthService } from '@/services/auth.service.js';
import type { BoardService } from '@/services/board.service.js';
import type { UserService } from '@/services/user.service.js';
import { logger } from '@/lib/logger.js';

export interface UpgradeContext {
  boardId: string
  userId: string
  userName: string
  avatarUrl: string | null
  permission: 'view' | 'edit'
  lastSequence: number
  sessionId: string
}

const ACCESS_TOKEN_COOKIE_NAME = 'accessToken';

function parseBoardIdFromPath(pathname: string): string | null {
    const match = pathname.match(/^\/boards\/([^/]+)\/ws$/);
    return match ? match[1] : null;
}

function parseLastSequence(raw: string | null): number {
    const parsed = parseInt(raw ?? '0', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseCookieHeader(raw: string | undefined): Record<string, string> {
    if (!raw) {
        return {};
    }

    const entries = raw.split(';');
    const result: Record<string, string> = {};
    for (const entry of entries) {
        const [name, ...rest] = entry.trim().split('=');
        if (!name || rest.length === 0) {
            continue;
        }

        result[name] = decodeURIComponent(rest.join('='));
    }

    return result;
}

function resolveAccessToken(request: IncomingMessage): string | null {
    const cookieToken = parseCookieHeader(request.headers.cookie)[ACCESS_TOKEN_COOKIE_NAME];
    if (cookieToken) {
        return cookieToken;
    }

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    return null;
}

function parseAllowedOrigins(raw: string): string[] {
    return raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}

function isTrustedOrigin(origin: string | undefined, allowedOrigins: Set<string>): boolean {
    if (!origin) {
        return false;
    }

    return allowedOrigins.has(origin);
}

export function createUpgradeHandler(
    wss: WebSocketServer,
    authService: AuthService,
    userService: UserService,
    boardService: BoardService,
    corsOrigin: string,
) {
    const allowedOrigins = new Set(parseAllowedOrigins(corsOrigin));

    return async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
        try {
            const rawUrl = request.url;
            if (!rawUrl) {
                socket.destroy();
                return;
            }

            const url = new URL(rawUrl, `http://${request.headers.host}`);
            const boardId = parseBoardIdFromPath(url.pathname);
            if (!boardId) {
                // Not a raw board websocket endpoint. Let other upgrade handlers (e.g. Socket.IO) process it.
                return;
            }

            const origin = request.headers.origin;
            if (!isTrustedOrigin(origin, allowedOrigins)) {
                logger.warn({ origin, path: url.pathname }, '[WS Upgrade] Rejected untrusted origin');
                socket.destroy();
                return;
            }

            const lastSequence = parseLastSequence(url.searchParams.get('lastSequence'));
            const sessionId = randomUUID();

            const shareToken = url.searchParams.get('shareToken') ?? undefined;
            const token = resolveAccessToken(request);
            let userId: string | undefined;

            if (token) {
                const payload = authService.verifyAccessToken(token);
                userId = payload.sub;
            }

            const access = await boardService.checkBoardAccess(boardId, userId, shareToken);
            if (!access.hasAccess) {
                logger.warn({ boardId, userId: userId ?? null }, '[WS Upgrade] Rejected unauthorized board access');
                socket.destroy();
                return;
            }

            let userName = 'Guest';
            let avatarUrl: string | null = null;
            let resolvedUserId = userId ?? `anonymous:${sessionId}`;

            if (userId) {
                const user = await userService.getUserById(userId);
                if (!user) {
                    socket.destroy();
                    return;
                }

                resolvedUserId = user.id;
                userName = user.name;
                avatarUrl = user.avatarUrl ?? null;
            }

            const context: UpgradeContext = {
                boardId,
                userId: resolvedUserId,
                userName,
                avatarUrl,
                permission: access.permission === 'edit' ? 'edit' : 'view',
                lastSequence,
                sessionId,
            }

      ;(request as any).__wsContext = context;

            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } catch (err) {
            logger.error({ err }, '[WS Upgrade] Failed');
            socket.destroy();
        }
    };
}
