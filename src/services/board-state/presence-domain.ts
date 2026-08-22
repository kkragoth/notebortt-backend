import type Redis from 'ioredis';
import type { RuntimeMetrics } from '@/observability/metrics.js';
import type { BoardSyncWriteMode } from '@/services/board-state/types.js';
import { ACTIVE_BOARDS_KEY, CLIENT_LEASE_TTL_SECONDS, COLLAB_MODE_COOLDOWN_MS, VIEWER_SESSION_TTL_MS, boardClientLeaseKey, boardClientsKey, boardCollabModeUntilKey, boardLastActiveKey, boardViewerSessionsKey, clientMember } from '@/services/board-state/keys.js';

interface PresenceDomainDeps {
  waitForBoardLoad: (boardId: string) => Promise<void>
  metrics: RuntimeMetrics
}

export function createBoardPresenceDomain(redis: Redis, deps: PresenceDomainDeps) {
    const { waitForBoardLoad, metrics } = deps;

    async function extendCollabMode(boardId: string): Promise<void> {
        const collabUntil = Date.now() + COLLAB_MODE_COOLDOWN_MS;
        await redis.set(boardCollabModeUntilKey(boardId), collabUntil.toString(), 'PX', COLLAB_MODE_COOLDOWN_MS);
    }

    async function extendCollabModeIfNeeded(boardId: string, participantCount: number): Promise<void> {
        if (participantCount >= 2) {
            await extendCollabMode(boardId);
        }
    }

    async function trackClient(boardId: string, userId: string, connectionId: string): Promise<void> {
        await waitForBoardLoad(boardId);
        const member = clientMember(userId, connectionId);
        await redis
            .pipeline()
            .sadd(boardClientsKey(boardId), member)
            .set(boardClientLeaseKey(boardId, member), '1', 'EX', CLIENT_LEASE_TTL_SECONDS)
            .sadd(ACTIVE_BOARDS_KEY, boardId)
            .exec();
        metrics.incrementCounter('redis.commands', 1, { category: 'presence', command: 'pipeline.exec' });

        const clientCount = await redis.scard(boardClientsKey(boardId));
        await extendCollabModeIfNeeded(boardId, clientCount);
    }

    async function removeClient(boardId: string, userId: string, connectionId: string): Promise<void> {
        await waitForBoardLoad(boardId);
        const member = clientMember(userId, connectionId);
        await redis
            .pipeline()
            .srem(boardClientsKey(boardId), member)
            .del(boardClientLeaseKey(boardId, member))
            .exec();
    }

    async function pruneStaleClients(boardId: string): Promise<void> {
        const members = await redis.smembers(boardClientsKey(boardId));
        if (members.length === 0) {
            return;
        }

        const checks = redis.pipeline();
        for (const member of members) {
            checks.exists(boardClientLeaseKey(boardId, member));
        }
        const leaseResults = await checks.exec();
        if (!leaseResults) {
            return;
        }

        const staleMembers: string[] = [];
        for (let i = 0; i < members.length; i++) {
            const member = members[i];
            if (!member) continue;
            const leaseExists = leaseResults[i]?.[1];
            if (leaseExists !== 1) {
                staleMembers.push(member);
            }
        }

        if (staleMembers.length > 0) {
            await redis.srem(boardClientsKey(boardId), ...staleMembers);
        }
    }

    async function getClientCount(boardId: string): Promise<number> {
        await waitForBoardLoad(boardId);
        await pruneStaleClients(boardId);
        return redis.scard(boardClientsKey(boardId));
    }

    async function touchViewerSession(boardId: string, sessionId: string): Promise<void> {
        await waitForBoardLoad(boardId);
        const now = Date.now();
        const minActiveTimestamp = now - VIEWER_SESSION_TTL_MS;
        await redis
            .pipeline()
            .zadd(boardViewerSessionsKey(boardId), now, sessionId)
            .zremrangebyscore(boardViewerSessionsKey(boardId), 0, minActiveTimestamp)
            .set(boardLastActiveKey(boardId), now.toString())
            .sadd(ACTIVE_BOARDS_KEY, boardId)
            .exec();
        metrics.incrementCounter('redis.commands', 1, { category: 'presence', command: 'pipeline.exec' });

        const viewerCount = await redis.zcard(boardViewerSessionsKey(boardId));
        await extendCollabModeIfNeeded(boardId, viewerCount);
    }

    async function removeViewerSession(boardId: string, sessionId: string): Promise<void> {
        await waitForBoardLoad(boardId);
        await redis.zrem(boardViewerSessionsKey(boardId), sessionId);
    }

    async function getActiveViewerCount(boardId: string): Promise<number> {
        await waitForBoardLoad(boardId);
        const now = Date.now();
        const minActiveTimestamp = now - VIEWER_SESSION_TTL_MS;
        await redis.zremrangebyscore(boardViewerSessionsKey(boardId), 0, minActiveTimestamp);
        return redis.zcard(boardViewerSessionsKey(boardId));
    }

    async function touchLastActive(boardId: string): Promise<void> {
        await waitForBoardLoad(boardId);
        const now = Date.now();
        await redis
            .pipeline()
            .set(boardLastActiveKey(boardId), now.toString())
            .sadd(ACTIVE_BOARDS_KEY, boardId)
            .exec();
        metrics.incrementCounter('redis.commands', 1, { category: 'presence', command: 'pipeline.exec' });
    }

    async function getSyncWriteMode(boardId: string): Promise<BoardSyncWriteMode> {
        await waitForBoardLoad(boardId);

        const collabUntilRaw = await redis.get(boardCollabModeUntilKey(boardId));
        if (collabUntilRaw) {
            const collabUntil = parseInt(collabUntilRaw, 10);
            if (Number.isFinite(collabUntil) && collabUntil > Date.now()) {
                return 'collab';
            }
        }

        const [clientCount, viewerCount] = await Promise.all([
            getClientCount(boardId),
            getActiveViewerCount(boardId),
        ]);

        if (clientCount >= 2 || viewerCount >= 2) {
            await extendCollabMode(boardId);
            return 'collab';
        }

        return 'solo';
    }

    return {
        trackClient,
        removeClient,
        getClientCount,
        touchViewerSession,
        removeViewerSession,
        getActiveViewerCount,
        touchLastActive,
        getSyncWriteMode,
    };
}

export type BoardPresenceDomain = ReturnType<typeof createBoardPresenceDomain>
