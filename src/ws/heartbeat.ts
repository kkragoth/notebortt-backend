import type { BoardRoomManager } from './room.js'
import { serialize } from './messages.js'

export function createHeartbeatService(roomManager: BoardRoomManager) {
  let intervalHandle: NodeJS.Timeout | null = null
  const DEFAULT_STALE_CLIENT_IDLE_MS = 90_000

  function sendPings(): void {
    const rooms = roomManager.getAllRooms()
    const pingMessage = serialize({ type: 'PING' })
    for (const [, room] of rooms) {
      for (const [, client] of room) {
        if (client.ws.readyState === 1) {
          client.ws.send(pingMessage)
        }
      }
    }
  }

  function checkStaleClients(maxMissedMs = DEFAULT_STALE_CLIENT_IDLE_MS): void {
    const now = Date.now()
    const rooms = roomManager.getAllRooms()
    for (const [, room] of rooms) {
      for (const [connectionId, client] of room) {
        if (now - client.lastPong > maxMissedMs) {
          console.log(`[Heartbeat] Closing stale connection ${connectionId}`)
          client.ws.close(4408, 'Heartbeat timeout')
        }
      }
    }
  }

  function handlePong(boardId: string, connectionId: string): void {
    const client = roomManager.getClientByConnectionId(boardId, connectionId)
    if (client) client.lastPong = Date.now()
  }

  function handleActivity(boardId: string, connectionId: string): void {
    const client = roomManager.getClientByConnectionId(boardId, connectionId)
    if (client) client.lastPong = Date.now()
  }

  function startHeartbeat(intervalMs = 30000): void {
    intervalHandle = setInterval(() => {
      sendPings()
      setTimeout(() => checkStaleClients(intervalMs + 10000), 5000)
    }, intervalMs)
  }

  function stopHeartbeat(): void {
    if (intervalHandle) {
      clearInterval(intervalHandle)
      intervalHandle = null
    }
  }

  return { handlePong, handleActivity, startHeartbeat, stopHeartbeat }
}

export type HeartbeatService = ReturnType<typeof createHeartbeatService>
