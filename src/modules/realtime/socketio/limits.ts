import { SOCKET_CLIENT_EVENTS } from './constants.js';

// Realtime hardening limits (P3). Values here are enforcement knobs, not
// wire-format names — changing them does not break clients.

export const SOCKET_PING_TIMEOUT_MS = 5_000;
export const SOCKET_PING_INTERVAL_MS = 10_000;
export const SOCKET_MAX_HTTP_BUFFER_BYTES = 512 * 1024;

/** Per-event payload caps (JSON bytes); transport cap is maxHttpBufferSize. */
export const SOCKET_EVENT_BYTE_CAPS = {
    [SOCKET_CLIENT_EVENTS.MUTATION_BATCH]: 256 * 1024,
    [SOCKET_CLIENT_EVENTS.CRDT_UPDATE]: 128 * 1024,
    [SOCKET_CLIENT_EVENTS.REALTIME_TICK]: 32 * 1024,
    [SOCKET_CLIENT_EVENTS.PRESENCE_UPDATE]: 8 * 1024,
    [SOCKET_CLIENT_EVENTS.BOARD_JOIN]: 4 * 1024,
} as const satisfies Partial<Record<string, number>>;

/** Per-socket token bucket applied to every client event. */
export const SOCKET_EVENT_BUCKET_CAPACITY = 120;
export const SOCKET_EVENT_REFILL_PER_SECOND = 30;

/** Upper bound of simultaneous participants in one board room. */
export const SOCKET_ROOM_CONNECTION_CAP = 50;
