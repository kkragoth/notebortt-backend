import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { WebSocketServer } from 'ws'
import type { AuthService } from '../services/auth.service.js'
import type { UserService } from '../services/user.service.js'

export interface UpgradeContext {
  boardId: string
  userId: string
  userName: string
  avatarUrl: string | null
  lastSequence: number
}

function parseBoardIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/boards\/([^/]+)\/ws$/)
  return match ? match[1] : null
}

function parseLastSequence(raw: string | null): number {
  return parseInt(raw ?? '0', 10)
}

export function createUpgradeHandler(wss: WebSocketServer, authService: AuthService, userService: UserService) {
  return async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    try {
      console.log('[WS Upgrade] Request:', request.url)
      const url = new URL(request.url!, `http://${request.headers.host}`)

      const boardId = parseBoardIdFromPath(url.pathname)
      if (!boardId) {
        socket.destroy()
        return
      }

      const token = url.searchParams.get('token')
      if (!token) {
        socket.destroy()
        return
      }

      const lastSequence = parseLastSequence(url.searchParams.get('lastSequence'))

      const payload = authService.verifyAccessToken(token)
      const user = await userService.getUserById(payload.sub)
      if (!user) {
        socket.destroy()
        return
      }

      const context: UpgradeContext = {
        boardId,
        userId: user.id,
        userName: user.name,
        avatarUrl: user.avatarUrl ?? null,
        lastSequence,
      }

      ;(request as any).__wsContext = context

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    } catch (err) {
      console.error('[WS Upgrade] Failed:', err)
      socket.destroy()
    }
  }
}
