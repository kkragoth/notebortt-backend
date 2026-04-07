import type Redis from 'ioredis'
import type { Database } from '../db/client.js'
import { createBoardLoadDomain } from './board-state/load-domain.js'
import { createBoardPersistenceDomain } from './board-state/persistence-domain.js'
import { createBoardPresenceDomain } from './board-state/presence-domain.js'
import { createBoardStateDomain } from './board-state/state-domain.js'

export type {
  ApplyChangeSetOptions,
  BoardRuntimeMetrics,
  BoardSnapshot,
  BoardSyncWriteMode,
  ElementChangeSet,
  PersistedElementChange,
} from './board-state/types.js'

export function createBoardStateService(redis: Redis, db: Database) {
  const loadDomain = createBoardLoadDomain(redis, db)
  const stateDomain = createBoardStateDomain(redis, {
    waitForBoardLoad: loadDomain.waitForBoardLoad,
  })
  const presenceDomain = createBoardPresenceDomain(redis, {
    waitForBoardLoad: loadDomain.waitForBoardLoad,
  })
  const persistenceDomain = createBoardPersistenceDomain(redis, db, {
    waitForBoardLoad: loadDomain.waitForBoardLoad,
    getElements: stateDomain.getElements,
    peekSequence: stateDomain.peekSequence,
  })

  return {
    loadBoard: loadDomain.loadBoard,
    getElements: stateDomain.getElements,
    getElement: stateDomain.getElement,
    setElement: stateDomain.setElement,
    deleteElement: stateDomain.deleteElement,
    getSequence: stateDomain.getSequence,
    peekSequence: stateDomain.peekSequence,
    isDuplicate: stateDomain.isDuplicate,
    tryMarkSeen: stateDomain.tryMarkSeen,
    markSeen: stateDomain.markSeen,
    trackClient: presenceDomain.trackClient,
    removeClient: presenceDomain.removeClient,
    getClientCount: presenceDomain.getClientCount,
    touchViewerSession: presenceDomain.touchViewerSession,
    removeViewerSession: presenceDomain.removeViewerSession,
    getActiveViewerCount: presenceDomain.getActiveViewerCount,
    touchLastActive: presenceDomain.touchLastActive,
    applyChangeSet: stateDomain.applyChangeSet,
    getChangesAfter: stateDomain.getChangesAfter,
    persistBoard: persistenceDomain.persistBoard,
    persistDirtyBoards: persistenceDomain.persistDirtyBoards,
    getBoardMetrics: persistenceDomain.getBoardMetrics,
    getSnapshot: stateDomain.getSnapshot,
    getSyncWriteMode: presenceDomain.getSyncWriteMode,
    flushBoard: persistenceDomain.flushBoard,
  }
}

export type BoardStateService = ReturnType<typeof createBoardStateService>
