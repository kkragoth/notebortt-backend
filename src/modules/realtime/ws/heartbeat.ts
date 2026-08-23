import { serialize } from '../ws/messages.js';
import type { BoardRoomManager } from '../ws/room.js';
import { logger } from '@/shared/logger.js';

export function createHeartbeatService(roomManager: BoardRoomManager) {
    let intervalHandle: NodeJS.Timeout | null = null;
    const DEFAULT_STALE_CLIENT_IDLE_MS = 90_000;

    function sendPings(): void {
        const rooms = roomManager.getAllRooms();
        const pingMessage = serialize({ type: 'PING' });
        for (const [, room] of rooms) {
            for (const [, client] of room) {
                if (client.ws.readyState === 1) {
                    client.ws.send(pingMessage);
                }
            }
        }
    }

    function checkStaleClients(maxMissedMs = DEFAULT_STALE_CLIENT_IDLE_MS): void {
        const now = Date.now();
        const rooms = roomManager.getAllRooms();
        for (const [, room] of rooms) {
            for (const [connectionId, client] of room) {
                if (now - client.lastPong > maxMissedMs) {
                    logger.info({ connectionId }, '[Heartbeat] Closing stale connection');
                    client.ws.close(4408, 'Heartbeat timeout');
                }
            }
        }
    }

    function handlePong(boardId: string, connectionId: string): void {
        const client = roomManager.getClientByConnectionId(boardId, connectionId);
        if (client) client.lastPong = Date.now();
    }

    function handleActivity(boardId: string, connectionId: string): void {
        const client = roomManager.getClientByConnectionId(boardId, connectionId);
        if (client) client.lastPong = Date.now();
    }

    function startHeartbeat(intervalMs = 30000): void {
        const staleThresholdMs = Math.max(DEFAULT_STALE_CLIENT_IDLE_MS, intervalMs + 10_000);
        intervalHandle = setInterval(() => {
            sendPings();
            setTimeout(() => checkStaleClients(staleThresholdMs), 5000);
        }, intervalMs);
    }

    function stopHeartbeat(): void {
        if (intervalHandle) {
            clearInterval(intervalHandle);
            intervalHandle = null;
        }
    }

    return { handlePong, handleActivity, startHeartbeat, stopHeartbeat };
}

export type HeartbeatService = ReturnType<typeof createHeartbeatService>
