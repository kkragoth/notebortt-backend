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
  const rooms = new Map<string, {
    connections: Map<string, ConnectedClient>
    sessions: Map<string, string>
  }>()

  function getOrCreateRoom(boardId: string) {
    if (!rooms.has(boardId)) {
      rooms.set(boardId, {
        connections: new Map(),
        sessions: new Map(),
      })
    }

    return rooms.get(boardId)!
  }

  function joinRoom(boardId: string, client: ConnectedClient): ConnectedClient | null {
    const room = getOrCreateRoom(boardId)
    const replacedConnectionId = room.sessions.get(client.sessionId)
    const replacedClient = replacedConnectionId
      ? room.connections.get(replacedConnectionId) ?? null
      : null

    if (replacedConnectionId) {
      room.connections.delete(replacedConnectionId)
    }

    room.connections.set(client.connectionId, client)
    room.sessions.set(client.sessionId, client.connectionId)

    if (!replacedClient) {
      broadcastToRoom(boardId, {
        type: 'USER_JOINED',
        sessionId: client.sessionId,
        userId: client.userId,
        userName: client.userName,
        avatarUrl: client.avatarUrl ?? null,
        color: client.color,
      }, client.connectionId)
    }

    return replacedClient
  }

  function leaveRoom(boardId: string, connectionId: string): {
    client: ConnectedClient | null
    sessionStillActive: boolean
  } {
    const room = rooms.get(boardId)
    if (!room) {
      return { client: null, sessionStillActive: false }
    }

    const client = room.connections.get(connectionId)
    if (!client) {
      return { client: null, sessionStillActive: false }
    }

    room.connections.delete(connectionId)

    const activeConnectionId = room.sessions.get(client.sessionId)
    const sessionStillActive = activeConnectionId !== undefined && activeConnectionId !== connectionId
    if (!sessionStillActive && activeConnectionId === connectionId) {
      room.sessions.delete(client.sessionId)
      broadcastToRoom(boardId, { type: 'USER_LEFT', sessionId: client.sessionId, userId: client.userId })
    }

    if (room.connections.size === 0) {
      rooms.delete(boardId)
    }

    return { client, sessionStillActive }
  }

  function getRoom(boardId: string): ConnectedClient[] {
    const room = rooms.get(boardId)
    return room ? [...room.connections.values()] : []
  }

  function getRoomSize(boardId: string): number {
    return rooms.get(boardId)?.connections.size ?? 0
  }

  function broadcastToRoom(boardId: string, message: ServerMessage, excludeConnectionId?: string): void {
    const room = rooms.get(boardId)
    if (!room) return
    const data = serialize(message)
    for (const [connId, client] of room.connections) {
      if (connId === excludeConnectionId) continue
      if (client.ws.readyState === 1) {
        client.ws.send(data)
      }
    }
  }

  function getClientByConnectionId(boardId: string, connectionId: string): ConnectedClient | undefined {
    return rooms.get(boardId)?.connections.get(connectionId)
  }

  function getAllRooms(): Map<string, Map<string, ConnectedClient>> {
    return new Map(
      [...rooms.entries()].map(([boardId, room]) => [boardId, room.connections]),
    )
  }

  return { joinRoom, leaveRoom, getRoom, getRoomSize, broadcastToRoom, getClientByConnectionId, getAllRooms }
}

export type BoardRoomManager = ReturnType<typeof createBoardRoomManager>
