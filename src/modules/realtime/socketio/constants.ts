// Wire-format names. Changing any of these breaks clients/proxies that
// already speak this protocol — treat them as a public contract.

/** Events emitted by clients and handled by the realtime server. */
export const SOCKET_CLIENT_EVENTS = {
    BOARD_JOIN: 'board:join',
    MUTATION_BATCH: 'mutation:batch',
    CRDT_UPDATE: 'crdt:update',
    PRESENCE_UPDATE: 'presence:update',
    REALTIME_TICK: 'realtime:tick',
} as const;

/** Events emitted by the realtime server to clients. */
export const SOCKET_SERVER_EVENTS = {
    SYNC_ERROR: 'sync:error',
    MUTATION_BROADCAST: 'mutation',
    MUTATION_ACK: 'mutation:ack',
    CRDT_UPDATE: 'crdt:update',
    REALTIME_TICK: 'realtime:tick',
    PRESENCE: 'PRESENCE',
    USER_JOINED: 'USER_JOINED',
    USER_LEFT: 'USER_LEFT',
    BOARD_SNAPSHOT: 'board:snapshot',
} as const;

/** Reserved Socket.IO lifecycle events (framework-defined names). */
export const SOCKET_RESERVED_EVENTS = {
    CONNECTION: 'connection',
    CONNECT: 'connect',
    DISCONNECT: 'disconnect',
} as const;

export const ACCESS_TOKEN_COOKIE_NAME = 'accessToken';
export const TICK_PERSIST_DEBOUNCE_MS = 400;
export const TICK_PERSIST_MAX_WAIT_MS = 1500;
