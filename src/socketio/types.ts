import type Redis from 'ioredis'
import type { MutationProcessor } from '../mutations/processor.js'
import type { AuthService } from '../services/auth.service.js'
import type { BoardService } from '../services/board.service.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { UserService } from '../services/user.service.js'

export interface SocketIdentity {
  authUserId: string | undefined
  runtimeUserId: string
  userName: string
  avatarUrl: string | null
}

export interface SocketBoardContext {
  boardId: string
  sessionId: string
  permission: 'view' | 'edit'
  userId: string
  userName: string
  avatarUrl: string | null
  color: string
}

export interface RoomParticipant {
  sessionId: string
  userId: string
  userName: string
  avatarUrl: string | null
  color: string
}

export interface SocketIoRealtimeServerOptions {
  corsOrigin: string
  crdtDebounceMs?: number
  crdtMaxWaitMs?: number
}

export interface SocketIoRealtimeDependencies {
  authService: AuthService
  userService: UserService
  boardService: BoardService
  boardStateService: BoardStateService
  mutationProcessor: MutationProcessor
  pubRedis: Redis
}
