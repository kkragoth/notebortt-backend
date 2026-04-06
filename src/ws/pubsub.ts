import type Redis from 'ioredis'
import type { BoardRoomManager } from './room.js'
import { boardMutationChannel, extractBoardIdFromChannel, tryParseJson } from './handler.utils.js'

export function createBoardMutationPubSub(pubRedis: Redis, roomManager: BoardRoomManager) {
  const subRedis = pubRedis.duplicate()
  const subscribedBoards = new Set<string>()

  subRedis.on('message', (channel: string, message: string) => {
    const boardId = extractBoardIdFromChannel(channel)
    if (!boardId) {
      return
    }

    const parsed = tryParseJson(message)
    if (!parsed) {
      return
    }

    const { mutation, fromUserId, senderConnectionId } = parsed
    roomManager.broadcastToRoom(boardId, { type: 'MUTATION', mutation, fromUserId }, senderConnectionId)
  })

  function ensureSubscribedToBoard(boardId: string): void {
    if (subscribedBoards.has(boardId)) {
      return
    }

    subscribedBoards.add(boardId)
    subRedis.subscribe(boardMutationChannel(boardId))
  }

  function unsubscribeFromBoard(boardId: string): void {
    subscribedBoards.delete(boardId)
    subRedis.unsubscribe(boardMutationChannel(boardId))
  }

  async function publishMutation(boardId: string, mutation: unknown, fromUserId: string, senderConnectionId: string) {
    const payload = JSON.stringify({ mutation, fromUserId, senderConnectionId })
    await pubRedis.publish(boardMutationChannel(boardId), payload)
  }

  return {
    ensureSubscribedToBoard,
    unsubscribeFromBoard,
    publishMutation,
  }
}
