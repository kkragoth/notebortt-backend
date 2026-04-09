import { ACCESS_TOKEN_COOKIE_NAME } from './constants.js'
import type { SocketIdentity, SocketIoRealtimeDependencies } from './types.js'

function parseCookieHeader(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {}
  }

  const cookies: Record<string, string> = {}
  for (const segment of raw.split(';')) {
    const [name, ...rest] = segment.trim().split('=')
    if (!name || rest.length === 0) {
      continue
    }
    cookies[name] = decodeURIComponent(rest.join('='))
  }
  return cookies
}

export async function resolveSocketIdentity(socket: any, deps: SocketIoRealtimeDependencies): Promise<SocketIdentity> {
  const headers = socket.request?.headers ?? {}
  const cookies = parseCookieHeader(headers.cookie as string | undefined)
  const cookieToken = cookies[ACCESS_TOKEN_COOKIE_NAME]
  const authHeader = typeof headers.authorization === 'string' ? headers.authorization : ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const rawToken = cookieToken ?? bearerToken

  if (!rawToken) {
    return {
      authUserId: undefined,
      runtimeUserId: `anonymous:${socket.id}`,
      userName: 'Guest',
      avatarUrl: null,
    }
  }

  try {
    const payload = deps.authService.verifyAccessToken(rawToken)
    const user = await deps.userService.getUserById(payload.sub)
    if (!user) {
      return {
        authUserId: undefined,
        runtimeUserId: `anonymous:${socket.id}`,
        userName: 'Guest',
        avatarUrl: null,
      }
    }
    return {
      authUserId: user.id,
      runtimeUserId: user.id,
      userName: user.name,
      avatarUrl: user.avatarUrl ?? null,
    }
  } catch {
    return {
      authUserId: undefined,
      runtimeUserId: `anonymous:${socket.id}`,
      userName: 'Guest',
      avatarUrl: null,
    }
  }
}
