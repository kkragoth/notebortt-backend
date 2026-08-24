import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createParticipantsStore } from '@/modules/realtime/socketio/participants.js';

const REDIS_URL = process.env.REDIS_REALTIME_URL ?? 'redis://localhost:6379';

describe('redis-backed participants store', () => {
    let redis: Redis;
    const boardIds: string[] = [];
    // Unique namespace: socketio.server.test flushes `board:*:participants*`
    // in parallel and would otherwise delete these entries mid-test.
    const keyPrefix = `t${Math.random().toString(36).slice(2, 8)}:`;

    beforeEach(() => {
        redis = new Redis(REDIS_URL);
    });

    afterEach(async () => {
        for (const boardId of boardIds) {
            await redis.del(`${keyPrefix}board:${boardId}:participants`, `${keyPrefix}board:${boardId}:participants_expiry`);
        }
        redis.disconnect();
    });

    function trackBoard(boardId: string): string {
        boardIds.push(boardId);
        return `${boardId}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function participantFor(sessionId: string) {
        return { sessionId, userId: `user-${sessionId}`, userName: sessionId, avatarUrl: null, color: '#000' };
    }

    it('stores, lists and removes participants across simulated nodes', async () => {
        const boardId = trackBoard('board-x');
        const store = createParticipantsStore(redis, { keyPrefix });

        await store.setParticipant(boardId, 'socket-1', participantFor('s1'));
        await store.setParticipant(boardId, 'socket-2', participantFor('s2'));

        expect(await store.getRoomSize(boardId)).toBe(2);

        let participants = await store.getRoomParticipants(boardId);
        expect(participants).toHaveLength(2);
        expect(participants.map((p) => p.sessionId).sort()).toEqual(['s1', 's2']);
        // socketId bookkeeping must not leak into the exposed payload
        expect(participants[0]).not.toHaveProperty('socketId');

        const removed = await store.removeParticipant(boardId, 'socket-1');
        expect(removed?.sessionId).toBe('s1');
        expect(await store.removeParticipant(boardId, 'socket-1')).toBeNull();
        expect(await store.getRoomSize(boardId)).toBe(1);

        participants = await store.getRoomParticipants(boardId);
        expect(participants.map((p) => p.sessionId)).toEqual(['s2']);
    });

    it('prunes expired entries on read so dead sockets cannot linger', async () => {
        const boardId = trackBoard('board-ttl');
        const store = createParticipantsStore(redis, { ttlMs: 40, keyPrefix });

        await store.setParticipant(boardId, 'socket-dead', participantFor('dead'));
        await new Promise((resolve) => setTimeout(resolve, 120));

        expect(await store.getRoomSize(boardId)).toBe(0);
        expect(await store.getRoomParticipants(boardId)).toEqual([]);
        // Removal after expiry is a clean no-op returning null.
        expect(await store.removeParticipant(boardId, 'socket-dead')).toBeNull();
    });

    it('touch extends the ttl of live sockets beyond the original window', async () => {
        const boardId = trackBoard('board-touch');
        const store = createParticipantsStore(redis, { ttlMs: 150, keyPrefix });

        await store.setParticipant(boardId, 'socket-live', participantFor('live'));
        // Keep touching past the original ttl; entry must never expire.
        for (let i = 0; i < 4; i += 1) {
            await store.touchParticipant(boardId, 'socket-live');
            await new Promise((resolve) => setTimeout(resolve, 80));
        }

        expect(await store.getRoomSize(boardId)).toBe(1);
    });
});
