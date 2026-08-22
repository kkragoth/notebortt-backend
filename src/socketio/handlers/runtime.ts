import type { Socket } from 'socket.io';
import type { createCrdtRoomStore } from '@/socketio/crdt-room.js';
import type { createParticipantsStore } from '@/socketio/participants.js';
import type { createTickPersistenceManager } from '@/socketio/tick-persistence.js';
import type {
    SocketBoardContext,
    SocketIdentity,
    SocketIoRealtimeDependencies,
} from '@/socketio/types.js';

export type PresenceTypingField = 'title' | 'body' | null

export interface ContextSnapshot {
  context: SocketBoardContext
  version: number
}

export interface SocketIoHandlerRuntime {
  socket: Socket
  deps: SocketIoRealtimeDependencies
  participantsStore: ReturnType<typeof createParticipantsStore>
  tickPersistence: ReturnType<typeof createTickPersistenceManager>
  crdtStore: ReturnType<typeof createCrdtRoomStore>
  setBoardContext: (next: SocketBoardContext | null) => void
  getBoardContext: () => SocketBoardContext | null
  takeContextSnapshot: (expectedBoardId?: string) => ContextSnapshot | null
  isSnapshotActive: (snapshot: ContextSnapshot) => boolean
  startJoinAttempt: () => number
  isJoinActive: (joinAttempt: number) => boolean
  getIdentity: () => SocketIdentity | null
  setIdentity: (identity: SocketIdentity) => void
  getLastTickId: () => number
  setLastTickId: (tickId: number) => void
  refreshSocketActivity: (snapshot: ContextSnapshot, forceWrite?: boolean) => Promise<void>
  detachFromBoard: (context: SocketBoardContext, broadcastLeave: boolean) => Promise<void>
  publishElementsChanged: (boardId: string, userId: string, change: unknown, senderId: string) => Promise<void>
}
