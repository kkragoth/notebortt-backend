import type { BoardElement } from '../../mutations/types.js'

export interface ElementChangeSet {
  upserts: BoardElement[]
  deletes: string[]
}

export interface PersistedElementChange extends ElementChangeSet {
  sequence: number
  serverTimestamp: number
}

export type BoardSyncWriteMode = 'solo' | 'collab'

export interface BoardRuntimeMetrics {
  sequence: number
  lastFlushedSequence: number
  dirtySince: number | null
  dirtyAgeMs: number
  lastFlushDurationMs: number | null
  lastFlushedAt: number | null
}

export interface BoardSnapshot {
  elements: Record<string, BoardElement>
  sequence: number
}

export interface ApplyChangeSetOptions {
  trackChangeLog?: boolean
  trackChanges?: boolean
  baseElementsForCascadeDelete?: Record<string, BoardElement>
}
