import type Redis from 'ioredis';
import type WebSocket from 'ws';
import type { IncomingMessage } from 'node:http';
import type { BoardStateService } from '@/services/board-state.service.js';
import type { UpgradeContext } from '@/ws/upgrade.js';
import { serialize } from '@/ws/messages.js';

const REDIS_MUTATION_CHANNEL_PREFIX = 'board:';
const REDIS_MUTATION_CHANNEL_SUFFIX = ':mutations';

export interface RateLimitState {
  count: number
  windowStart: number
}

export function boardMutationChannel(boardId: string): string {
    return `${REDIS_MUTATION_CHANNEL_PREFIX}${boardId}${REDIS_MUTATION_CHANNEL_SUFFIX}`;
}

export function isRateLimited(state: RateLimitState, limit: number): boolean {
    const now = Date.now();
    const windowElapsed = now - state.windowStart;

    if (windowElapsed >= 1000) {
        state.count = 0;
        state.windowStart = now;
    }

    state.count += 1;
    return state.count > limit;
}

export function extractWsContext(request: IncomingMessage): UpgradeContext | null {
    return (request as any).__wsContext ?? null;
}

export async function sendSnapshot(
    ws: WebSocket,
    boardId: string,
    boardStateService: BoardStateService,
    pubRedis: Redis,
): Promise<void> {
    const snapshot = await boardStateService.getSnapshot(boardId);

    ws.send(serialize({ type: 'SNAPSHOT', elements: snapshot.elements, lastSequence: snapshot.sequence }));
}

export async function sendInitialState(
    ws: WebSocket,
    boardId: string,
    lastSequence: number,
    boardStateService: BoardStateService,
    pubRedis: Redis,
): Promise<void> {
    if (lastSequence === 0) {
        await sendSnapshot(ws, boardId, boardStateService, pubRedis);
        return;
    }

    const catchUp = await boardStateService.getChangesAfter(boardId, lastSequence);
    if (catchUp.complete && catchUp.changes.length > 0) {
        ws.send(serialize({ type: 'CATCH_UP', changes: catchUp.changes }));
        return;
    }

    await sendSnapshot(ws, boardId, boardStateService, pubRedis);
}

export async function isBoardGloballyIdle(
    boardId: string,
    boardStateService: BoardStateService,
): Promise<boolean> {
    const [clientCount, viewerCount] = await Promise.all([
        boardStateService.getClientCount(boardId),
        boardStateService.getActiveViewerCount(boardId),
    ]);

    return clientCount === 0 && viewerCount === 0;
}

export function extractBoardIdFromChannel(channel: string): string | null {
    if (!channel.startsWith(REDIS_MUTATION_CHANNEL_PREFIX) || !channel.endsWith(REDIS_MUTATION_CHANNEL_SUFFIX)) {
        return null;
    }

    return channel.slice(REDIS_MUTATION_CHANNEL_PREFIX.length, channel.length - REDIS_MUTATION_CHANNEL_SUFFIX.length);
}

export function tryParseJson(raw: string): any | null {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
