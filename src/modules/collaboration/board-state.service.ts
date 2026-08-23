import { createBoardLoadDomain } from './/board-state/load-domain.js';
import { createBoardPersistenceDomain } from './/board-state/persistence-domain.js';
import { createBoardPresenceDomain } from './/board-state/presence-domain.js';
import { createBoardStateDomain } from './/board-state/state-domain.js';
import { createBoardMutationLockDomain } from './/board-state/mutation-lock-domain.js';
import type {RuntimeMetrics} from '@/platform/observability/metrics.js';
import type { Database } from '@/platform/db/client.js';
import type Redis from 'ioredis';
import {  createRuntimeMetrics } from '@/platform/observability/metrics.js';

export type {
    ApplyChangeSetOptions,
    BoardRuntimeMetrics,
    BoardSnapshot,
    BoardSyncWriteMode,
    ElementChangeSet,
    PersistedElementChange,
} from './/board-state/types.js';

interface BoardStateServiceOptions {
  enableIncrementalPersistence?: boolean
  metrics?: RuntimeMetrics
}

export function createBoardStateService(redis: Redis, db: Database, options: BoardStateServiceOptions = {}) {
    const metrics = options.metrics ?? createRuntimeMetrics();
    const loadDomain = createBoardLoadDomain(redis, db);
    const stateDomain = createBoardStateDomain(redis, {
        waitForBoardLoad: loadDomain.waitForBoardLoad,
        metrics,
    });
    const presenceDomain = createBoardPresenceDomain(redis, {
        waitForBoardLoad: loadDomain.waitForBoardLoad,
        metrics,
    });
    const mutationLockDomain = createBoardMutationLockDomain(redis);
    const persistenceDomain = createBoardPersistenceDomain(redis, db, {
        waitForBoardLoad: loadDomain.waitForBoardLoad,
        getElements: stateDomain.getElements,
        peekSequence: stateDomain.peekSequence,
        metrics,
        enableIncrementalPersistence: options.enableIncrementalPersistence ?? true,
    });

    return {
        loadBoard: loadDomain.loadBoard,
        getElements: stateDomain.getElements,
        getElement: stateDomain.getElement,
        getElementsByIds: stateDomain.getElementsByIds,
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
        withBoardMutationLock: mutationLockDomain.withBoardMutationLock,
        persistBoard: persistenceDomain.persistBoard,
        persistDirtyBoards: persistenceDomain.persistDirtyBoards,
        getBoardMetrics: persistenceDomain.getBoardMetrics,
        getSnapshot: stateDomain.getSnapshot,
        getSyncWriteMode: presenceDomain.getSyncWriteMode,
        flushBoard: persistenceDomain.flushBoard,
        metrics,
    };
}

export type BoardStateService = ReturnType<typeof createBoardStateService>
