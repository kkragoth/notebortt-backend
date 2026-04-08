import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import type { WebSocketServer } from 'ws'
import type { AuthService } from '../services/auth.service.js'
import type { BoardService } from '../services/board.service.js'
import type { UserService } from '../services/user.service.js'

export interface UpgradeContext {
  boardId: string
  userId: string
  userName: string
  avatarUrl: string | null
  permission: 'view' | 'edit'
  lastSequence: number
  sessionId: string
}

const ACCESS_TOKEN_COOKIE_NAME = 'accessToken'

function parseBoardIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/boards\/([^/]+)\/ws$/)
  return match ? match[1] : null
}

function parseLastSequence(raw: string | null): number {
  return parseInt(raw ?? '0', 10)
}

function parseCookieHeader(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {}
  }

  const entries = raw.split(';')
  const result: Record<string, string> = {}
  for (const entry of entries) {
    const [name, ...rest] = entry.trim().split('=')
    if (!name || rest.length === 0) {
      continue
    }

    result[name] = decodeURIComponent(rest.join('='))
  }

  return result
}

function resolveAccessToken(request: IncomingMessage, url: URL): string | null {
  const cookieToken = parseCookieHeader(request.headers.cookie)[ACCESS_TOKEN_COOKIE_NAME]
  if (cookieToken) {
    return cookieToken
  }

  const authHeader = request.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  return url.searchParams.get('token')
}

export function createUpgradeHandler(
  wss: WebSocketServer,
  authService: AuthService,
  userService: UserService,
  boardService: BoardService,
) {
  return async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    try {
      const url = new URL(request.url!, `http://${request.headers.host}`)

      const boardId = parseBoardIdFromPath(url.pathname)
      if (!boardId) {
        socket.destroy()
        return
      }

      const lastSequence = parseLastSequence(url.searchParams.get('lastSequence'))
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) {
        socket.destroy()
        return
      }

      const shareToken = url.searchParams.get('shareToken') ?? undefined
      const token = resolveAccessToken(request, url)
      let userId: string | undefined

      if (token) {
        const payload = authService.verifyAccessToken(token)
        userId = payload.sub
      }

      const access = await boardService.checkBoardAccess(boardId, userId, shareToken)
      if (!access.hasAccess) {
        socket.destroy()
        return
      }

      let userName = 'Guest'
      let avatarUrl: string | null = null
      let resolvedUserId = userId ?? `anonymous:${sessionId}`

      if (userId) {
        const user = await userService.getUserById(userId)
        if (!user) {
          socket.destroy()
          return
        }

        resolvedUserId = user.id
        userName = user.name
        avatarUrl = user.avatarUrl ?? null
      }

      const context: UpgradeContext = {
        boardId,
        userId: resolvedUserId,
        userName,
        avatarUrl,
        permission: access.permission === 'edit' ? 'edit' : 'view',
        lastSequence,
        sessionId,
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
