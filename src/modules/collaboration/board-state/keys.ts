export const SEEN_TTL_SECONDS = 300;
export const CHANGE_LOG_MAX_LENGTH = 2000;
export const DIRTY_BOARDS_KEY = 'boards:dirty';
export const DIRTY_BOARDS_BY_AGE_KEY = 'boards:dirty_by_age';
export const ACTIVE_BOARDS_KEY = 'boards:active';
export const VIEWER_SESSION_TTL_MS = 90_000;
export const CLIENT_LEASE_TTL_SECONDS = 90;
export const COLLAB_MODE_COOLDOWN_MS = 90_000;
export const BOARD_LOAD_LOCK_TTL_MS = 30_000;
export const BOARD_LOAD_LOCK_POLL_MS = 25;
export const BOARD_EVICTION_LOCK_TTL_MS = 30_000;
export const BOARD_EVICTION_LOCK_POLL_MS = 25;
export const BOARD_MUTATION_LOCK_TTL_MS = 30_000;
export const BOARD_MUTATION_LOCK_POLL_MS = 25;
// Bounded wait: a partitioned/held lock fails fast (503) instead of piling
// up unbounded request queues.
export const BOARD_MUTATION_LOCK_ACQUIRE_TIMEOUT_MS = 2_000;

export function boardSeqKey(boardId: string): string {
    return `board:${boardId}:seq`;
}

export function boardElementsKey(boardId: string): string {
    return `board:${boardId}:elements`;
}

export function boardSeenKey(boardId: string, mutationId: string): string {
    return `board:${boardId}:seen:${mutationId}`;
}

export function boardChangeLogKey(boardId: string): string {
    return `board:${boardId}:changes`;
}

export function boardClientsKey(boardId: string): string {
    return `board:${boardId}:clients`;
}

export function boardClientLeaseKey(boardId: string, member: string): string {
    return `board:${boardId}:client_lease:${member}`;
}

export function boardViewerSessionsKey(boardId: string): string {
    return `board:${boardId}:viewer_sessions`;
}

export function boardLastActiveKey(boardId: string): string {
    return `board:${boardId}:last_active`;
}

export function boardDirtyElementIdsKey(boardId: string): string {
    return `board:${boardId}:dirty_element_ids`;
}

export function boardDeletedElementIdsKey(boardId: string): string {
    return `board:${boardId}:deleted_element_ids`;
}

export function boardDirtySinceKey(boardId: string): string {
    return `board:${boardId}:dirty_since`;
}

export function boardDirtyEpochKey(boardId: string): string {
    return `board:${boardId}:dirty_epoch`;
}

export function boardLastFlushedSequenceKey(boardId: string): string {
    return `board:${boardId}:last_flushed_seq`;
}

export function boardLastFlushedAtKey(boardId: string): string {
    return `board:${boardId}:last_flushed_at`;
}

export function boardLastFlushDurationKey(boardId: string): string {
    return `board:${boardId}:last_flush_duration_ms`;
}

export function boardCollabModeUntilKey(boardId: string): string {
    return `board:${boardId}:collab_mode_until`;
}

export function boardLoadLockKey(boardId: string): string {
    return `board:${boardId}:load_lock`;
}

export function boardEvictionLockKey(boardId: string): string {
    return `board:${boardId}:eviction_lock`;
}

export function boardMutationLockKey(boardId: string): string {
    return `board:${boardId}:mutation_lock`;
}

export function clientMember(userId: string, connectionId: string): string {
    return `${userId}:${connectionId}`;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
