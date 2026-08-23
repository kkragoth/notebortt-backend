import type Redis from 'ioredis';
import type { BoardStateService, MutationProcessor  } from '@/modules/collaboration/index.js';
import type { AuthService } from '@/modules/auth/index.js';
import type { BoardService } from '@/modules/boards/index.js';
import type { UserService } from '@/modules/users/index.js';
import type { PreviewJobService } from '@/modules/previews/index.js';

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
  previewJobService: PreviewJobService
  pubRedis: Redis
}
