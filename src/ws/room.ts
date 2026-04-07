import type WebSocket from 'ws'
import { serialize, type ServerMessage } from './messages.js'

export interface ConnectedClient {
  ws: WebSocket
  sessionId: string
  userId: string
  userName: string
  avatarUrl?: string | null
  connectionId: string
  color: string
  lastPong: number
}

const USER_COLORS = [
  '#8B5CF6', '#EC4899', '#F59E0B', '#10B981',
  '#3B82F6', '#EF4444', '#6366F1', '#14B8A6',
]

export function getUserColor(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i)
    hash |= 0
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

export function createBoardRoomManager() {
  const rooms = new Map<string, Map<string, ConnectedClient>>()

  function getOrCreateRoom(boardId: string): Map<string, ConnectedClient> {
    if (!rooms.has(boardId)) rooms.set(boardId, new Map())
    return rooms.get(boardId)!
  }

  function joinRoom(boardId: string, client: ConnectedClient): void {
    const room = getOrCreateRoom(boardId)
    room.set(client.connectionId, client)
    broadcastToRoom(boardId, {
      type: 'USER_JOINED',
      sessionId: client.sessionId,
      userId: client.userId,
      userName: client.userName,
      avatarUrl: client.avatarUrl ?? null,
      color: client.color,
    }, client.connectionId)
  }

  function leaveRoom(boardId: string, connectionId: string): void {
    const room = rooms.get(boardId)
    if (!room) return
    const client = room.get(connectionId)
    if (!client) return
    room.delete(connectionId)
    broadcastToRoom(boardId, { type: 'USER_LEFT', sessionId: client.sessionId, userId: client.userId })
    if (room.size === 0) rooms.delete(boardId)
  }

  function getRoom(boardId: string): ConnectedClient[] {
    const room = rooms.get(boardId)
    return room ? [...room.values()] : []
  }

  function getRoomSize(boardId: string): number {
    return rooms.get(boardId)?.size ?? 0
  }

  function broadcastToRoom(boardId: string, message: ServerMessage, excludeConnectionId?: string): void {
    const room = rooms.get(boardId)
    if (!room) return
    const data = serialize(message)
    for (const [connId, client] of room) {
      if (connId === excludeConnectionId) continue
      if (client.ws.readyState === 1) {
        client.ws.send(data)
      }
    }
  }

  function getClientByConnectionId(boardId: string, connectionId: string): ConnectedClient | undefined {
    return rooms.get(boardId)?.get(connectionId)
  }

  function getAllRooms(): Map<string, Map<string, ConnectedClient>> {
    return rooms
  }

  return { joinRoom, leaveRoom, getRoom, getRoomSize, broadcastToRoom, getClientByConnectionId, getAllRooms }
}

export type BoardRoomManager = ReturnType<typeof createBoardRoomManager>
