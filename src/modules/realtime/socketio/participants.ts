import type Redis from 'ioredis';
import type { RoomParticipant } from '../socketio/types.js';

const DEFAULT_PARTICIPANT_TTL_MS = 90_000;
const PRUNE_BATCH = 200;

interface ParticipantsStoreOptions {
  ttlMs?: number
}

interface StoredParticipant extends RoomParticipant {
  socketId: string
}

function participantsHashKey(boardId: string): string {
    return `board:${boardId}:participants`;
}

function participantsExpiryKey(boardId: string): string {
    return `board:${boardId}:participants_expiry`;
}

/**
 * Cross-node participant registry. Socket.IO rooms alone cannot answer
 * "who is in this board" once the realtime tier scales past one replica,
 * so membership lives in Redis:
 *   - hash  board:<id>:participants           socketId -> participant JSON
 *   - zset  board:<id>:participants_expiry    socketId -> expiry epoch ms
 * Expired entries (crashed replica, dead socket without DISCONNECT) are
 * pruned lazily before every read.
 */
export function createParticipantsStore(redis: Redis, options: ParticipantsStoreOptions = {}) {
    const ttlMs = options.ttlMs ?? DEFAULT_PARTICIPANT_TTL_MS;

    async function pruneExpired(boardId: string): Promise<void> {
        const now = Date.now();
        const expired = await redis.zrangebyscore(
            participantsExpiryKey(boardId),
            '-inf',
            now,
            'LIMIT',
            0,
            PRUNE_BATCH,
        );
        if (expired.length === 0) {
            return;
        }
        await redis
            .pipeline()
            .hdel(participantsHashKey(boardId), ...expired)
            .zrem(participantsExpiryKey(boardId), ...expired)
            .exec();
    }

    async function setParticipant(boardId: string, socketId: string, participant: RoomParticipant): Promise<void> {
        const stored: StoredParticipant = { ...participant, socketId };
        await redis
            .pipeline()
            .hset(participantsHashKey(boardId), socketId, JSON.stringify(stored))
            .zadd(participantsExpiryKey(boardId), Date.now() + ttlMs, socketId)
            .exec();
    }

    async function touchParticipant(boardId: string, socketId: string): Promise<void> {
        await redis.zadd(
            participantsExpiryKey(boardId),
            'GT',
            Date.now() + ttlMs,
            socketId,
        );
    }

    async function removeParticipant(boardId: string, socketId: string): Promise<RoomParticipant | null> {
        // Atomic read-and-clear so two replicas detaching the same dead socket
        // cannot both report the participant.
        const result = await redis.eval(
            `
      local json = redis.call('hget', KEYS[1], ARGV[1])
      if not json then
        return nil
      end

      redis.call('hdel', KEYS[1], ARGV[1])
      redis.call('zrem', KEYS[2], ARGV[1])

      return json
    `,
            2,
            participantsHashKey(boardId),
            participantsExpiryKey(boardId),
            socketId,
        ) as string | null;

        if (!result) {
            return null;
        }

        try {
            const parsed = JSON.parse(result) as StoredParticipant;
            const { socketId: _socketId, ...participant } = parsed;
            return participant;
        } catch {
            return null;
        }
    }

    async function getRoomParticipants(boardId: string): Promise<RoomParticipant[]> {
        await pruneExpired(boardId);
        const raw = await redis.hvals(participantsHashKey(boardId));
        const participants: RoomParticipant[] = [];
        for (const json of raw) {
            try {
                const { socketId: _socketId, ...participant } = JSON.parse(json) as StoredParticipant;
                participants.push(participant);
            } catch {
                continue;
            }
        }
        return participants;
    }

    async function getRoomSize(boardId: string): Promise<number> {
        await pruneExpired(boardId);
        return redis.hlen(participantsHashKey(boardId));
    }

    return {
        setParticipant,
        touchParticipant,
        removeParticipant,
        getRoomParticipants,
        getRoomSize,
    };
}

export type ParticipantsStore = ReturnType<typeof createParticipantsStore>
