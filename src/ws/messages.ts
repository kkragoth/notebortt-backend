import type { Mutation, MutationResult, BoardElement } from '../mutations/types.js'
import type { PersistedElementChange } from '../services/board-state.service.js'

// Client → Server
export type ClientMessage =
  | { type: 'MUTATION'; mutation: Mutation }
  | {
      type: 'PRESENCE'
      cursor: { x: number; y: number } | null
      selectedIds?: string[]
      draggedIds?: string[]
      focusedElementId?: string | null
      typingField?: 'title' | 'body' | null
    }
  | { type: 'PONG' }

// Server → Client
export type ServerMessage =
  | { type: 'MUTATION'; mutation: Mutation; fromUserId: string }
  | { type: 'CATCH_UP'; changes: PersistedElementChange[] }
  | { type: 'CATCH_UP_FAILED'; reason: string }
  | { type: 'ELEMENTS_CHANGED'; change: PersistedElementChange; fromUserId: string }
  | { type: 'SNAPSHOT'; elements: Record<string, BoardElement>; lastSequence: number }
  | {
      type: 'PRESENCE'
      sessionId: string
      userId: string
      cursor: { x: number; y: number } | null
      selectedIds: string[]
      draggedIds?: string[]
      focusedElementId?: string | null
      typingField?: 'title' | 'body' | null
      userName: string
      avatarUrl: string | null
      color: string
    }
  | { type: 'USER_JOINED'; sessionId: string; userId: string; userName: string; avatarUrl: string | null; color: string }
  | { type: 'USER_LEFT'; sessionId: string; userId: string }
  | { type: 'UPGRADE'; message: string }
  | { type: 'DOWNGRADE'; message: string }
  | { type: 'PING' }
  | { type: 'RATE_LIMITED' }
  | { type: 'MUTATION_RESULT'; result: MutationResult }
  | { type: 'ERROR'; message: string }

export interface PresenceData {
  cursor: { x: number; y: number } | null
  selectedIds: string[]
  userName: string
  avatarUrl: string | null
  color: string
}

export function serialize(msg: ServerMessage): string {
  return JSON.stringify(msg)
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage
  } catch {
    return null
  }
}
