import { boardMutationChannel, extractBoardIdFromChannel, tryParseJson } from '../ws/handler.utils.js';
import type Redis from 'ioredis';
import type { BoardRoomManager } from '../ws/room.js';
import type { ServerMessage } from '../ws/messages.js';

export function createBoardMutationPubSub(pubRedis: Redis, roomManager: BoardRoomManager) {
    const subRedis = pubRedis.duplicate();
    const subscribedBoards = new Set<string>();

    subRedis.on('message', (channel: string, payload: string) => {
        const boardId = extractBoardIdFromChannel(channel);
        if (!boardId) {
            return;
        }

        const parsed = tryParseJson(payload);
        if (!parsed) {
            return;
        }

        const { message: serverMessage, senderConnectionId } = parsed as {
      message?: ServerMessage
      senderConnectionId?: string
    };
        if (!serverMessage) {
            return;
        }

        roomManager.broadcastToRoom(boardId, serverMessage, senderConnectionId);
    });

    function ensureSubscribedToBoard(boardId: string): void {
        if (subscribedBoards.has(boardId)) {
            return;
        }

        subscribedBoards.add(boardId);
        subRedis.subscribe(boardMutationChannel(boardId));
    }

    function unsubscribeFromBoard(boardId: string): void {
        subscribedBoards.delete(boardId);
        subRedis.unsubscribe(boardMutationChannel(boardId));
    }

    async function publishMessage(boardId: string, message: ServerMessage, senderConnectionId: string) {
        const payload = JSON.stringify({ message, senderConnectionId });
        await pubRedis.publish(boardMutationChannel(boardId), payload);
    }

    return {
        ensureSubscribedToBoard,
        unsubscribeFromBoard,
        publishMessage,
    };
}
