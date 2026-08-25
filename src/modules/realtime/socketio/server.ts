import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createCrdtRoomStore } from '../socketio/crdt-room.js';
import { createParticipantsStore } from '../socketio/participants.js';
import { createTickPersistenceManager } from '../socketio/tick-persistence.js';
import {
    ACCESS_TOKEN_COOKIE_NAME,
    SOCKET_CLIENT_EVENTS,
    SOCKET_RESERVED_EVENTS, SOCKET_SERVER_EVENTS 
} from '../socketio/constants.js';
import { createBoardJoinHandler } from '../socketio/handlers/join.handler.js';
import { createMutationBatchHandler } from '../socketio/handlers/mutation-batch.handler.js';
import { createCrdtUpdateHandler } from '../socketio/handlers/crdt-update.handler.js';
import { createPresenceUpdateHandler } from '../socketio/handlers/presence-update.handler.js';
import { createRealtimeTickHandler } from '../socketio/handlers/realtime-tick.handler.js';
import { createDisconnectHandler } from '../socketio/handlers/disconnect.handler.js';
import {
    decrementOpenSocketIoConnections,
    getOpenSocketIoConnections,
    incrementOpenSocketIoConnections,
} from '../socketio/stats.js';
import { parseCookieHeader } from '../socketio/identity.js';
import {
    SOCKET_EVENT_BUCKET_CAPACITY,
    SOCKET_EVENT_BYTE_CAPS,
    SOCKET_EVENT_REFILL_PER_SECOND,
    SOCKET_MAX_HTTP_BUFFER_BYTES,
    SOCKET_PING_INTERVAL_MS,
    SOCKET_PING_TIMEOUT_MS,
} from '../socketio/limits.js';
import type { ContextSnapshot, SocketIoHandlerRuntime } from '../socketio/handlers/runtime.js';
import type {
    RoomParticipant,
    SocketBoardContext,
    SocketIdentity,
    SocketIoRealtimeDependencies,
    SocketIoRealtimeServerOptions,
} from '../socketio/types.js';
import type { Server as HttpServer } from 'node:http';

import { logger } from '@/shared/logger.js';
import { parseAllowedOrigins } from '@/shared/cors.js';

const DEFAULT_ACTIVITY_WRITE_THROTTLE_MS = 3_000;
const DEFAULT_ACTIVITY_WRITE_JITTER_MS = 400;
// Well under the participants store TTL so three missed beats still survive.
const DEFAULT_PARTICIPANT_HEARTBEAT_MS = 30_000;

export function createSocketIoRealtimeServer(
    httpServer: HttpServer,
    deps: SocketIoRealtimeDependencies,
    options: SocketIoRealtimeServerOptions,
) {
    const activityWriteThrottleMs = options.activityWriteThrottleMs ?? DEFAULT_ACTIVITY_WRITE_THROTTLE_MS;
    const activityWriteJitterMs = options.activityWriteJitterMs ?? DEFAULT_ACTIVITY_WRITE_JITTER_MS;

    const io = new Server(httpServer, {
        transports: ['websocket'],
        cors: {
            origin: parseAllowedOrigins(options.corsOrigin),
            credentials: true,
        },
        pingTimeout: SOCKET_PING_TIMEOUT_MS,
        pingInterval: SOCKET_PING_INTERVAL_MS,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_BYTES,
    });

    // Cross-replica broadcasting (rooms, USER_JOINED/LEFT, element changes)
    // requires the redis adapter once more than one realtime replica runs.
    io.adapter(createAdapter(deps.pubRedis, deps.subRedis));

    // Handshake auth gate: a socket must present a valid JWT (auth payload,
    // Authorization header, or access-token cookie) or an explicit anonymous
    // opt-in via shareToken. Per-board access is still re-verified on every
    // join — this gate only fails fast on credential-less connections.
    io.use(async (socket, next) => {
        try {
            const headers = socket.request?.headers ?? {};
            const cookies = parseCookieHeader(headers.cookie);
            const authToken = (socket.handshake?.auth as { token?: string } | undefined)?.token;
            const bearerToken = typeof headers.authorization === 'string' && headers.authorization.startsWith('Bearer ')
                ? headers.authorization.slice(7)
                : undefined;
            const candidates = [
                authToken,
                bearerToken,
                cookies[`__Host-${ACCESS_TOKEN_COOKIE_NAME}`],
                cookies[ACCESS_TOKEN_COOKIE_NAME],
            ].filter((token): token is string => typeof token === 'string' && token.length > 0);

            for (const token of candidates) {
                try {
                    deps.authService.verifyAccessToken(token);
                    next();
                    return;
                } catch {
                    continue;
                }
            }

            const shareToken = typeof socket.handshake.query.shareToken === 'string'
                ? socket.handshake.query.shareToken
                : (socket.handshake.auth as { shareToken?: unknown } | undefined)?.shareToken;
            if (typeof shareToken === 'string' && shareToken.trim().length > 0) {
                next();
                return;
            }

            logger.warn({ socketId: socket.id }, '[socketio] rejected credential-less handshake');
            next(new Error('unauthorized'));
        } catch (error) {
            logger.error({ err: error }, '[socketio] handshake auth failed');
            next(new Error('unauthorized'));
        }
    });

    const participantsStore = createParticipantsStore(deps.pubRedis);
    // Persisted-change diffs are not re-broadcast: clients already applied
    // the live MUTATION_BROADCAST / CRDT_UPDATE / REALTIME_TICK events, and
    // reconnecting clients reconcile via BOARD_SNAPSHOT. (The old
    // boardMutationsChannel pub/sub predates the socket.io adapter and had
    // no subscriber.)
    const tickPersistence = createTickPersistenceManager(deps);
    const crdtStore = createCrdtRoomStore(deps.boardStateService, deps.mutationProcessor, {
        debounceMs: options.crdtDebounceMs,
        maxWaitMs: options.crdtMaxWaitMs,
    });

    function emitUserLeft(boardId: string, participant: RoomParticipant): void {
        io.to(boardId).emit(SOCKET_SERVER_EVENTS.USER_LEFT, {
            sessionId: participant.sessionId,
            userId: participant.userId,
        });
    }

    io.on(SOCKET_RESERVED_EVENTS.CONNECTION, (socket) => {
        incrementOpenSocketIoConnections();
        deps.metrics?.setGauge('socketio_connected_sockets', getOpenSocketIoConnections());
        socket.once(SOCKET_RESERVED_EVENTS.DISCONNECT, () => {
            decrementOpenSocketIoConnections();
            deps.metrics?.setGauge('socketio_connected_sockets', getOpenSocketIoConnections());
        });

        let boardContext: SocketBoardContext | null = null;
        let boardContextVersion = 0;
        let identity: SocketIdentity | null = null;
        let lastTickId = -1;
        let latestJoinAttempt = 0;

        // Per-socket token bucket: sustained event floods beyond the refill
        // rate are dropped instead of consuming downstream locks/redis.
        let bucketTokens = SOCKET_EVENT_BUCKET_CAPACITY;
        let bucketUpdatedAt = Date.now();
        function consumeEventToken(): boolean {
            const now = Date.now();
            bucketTokens = Math.min(
                SOCKET_EVENT_BUCKET_CAPACITY,
                bucketTokens + ((now - bucketUpdatedAt) / 1000) * SOCKET_EVENT_REFILL_PER_SECOND,
            );
            bucketUpdatedAt = now;
            if (bucketTokens < 1) {
                return false;
            }
            bucketTokens -= 1;
            return true;
        }

        function payloadExceedsCap(event: SocketServerEvent, payload: unknown): boolean {
            const cap = (SOCKET_EVENT_BYTE_CAPS as Record<string, number | undefined>)[event];
            if (cap === undefined) {
                return false;
            }
            try {
                return Buffer.byteLength(JSON.stringify(payload ?? null)) > cap;
            } catch {
                return true;
            }
        }
        const lastActivityWriteAtBySocketId = new Map<string, number>();
        const activityJitterBySocketId = new Map<string, number>();
        // Keeps the redis participant entry alive even for idle-but-connected
        // sockets: activity-based refresh alone would expire quiet users after
        // PARTICIPANT_TTL_MS and corrupt rosters / room-size checks. Started
        // lazily on first join so never-joined sockets hold no timers.
        let participantHeartbeat: NodeJS.Timeout | undefined;
        function startParticipantHeartbeat(): void {
            if (participantHeartbeat) {
                return;
            }
            participantHeartbeat = setInterval(() => {
                if (boardContext && socket.connected) {
                    void participantsStore.touchParticipant(boardContext.boardId, socket.id);
                } else if (!boardContext) {
                    stopParticipantHeartbeat();
                }
            }, DEFAULT_PARTICIPANT_HEARTBEAT_MS);
            participantHeartbeat.unref();
        }

        function stopParticipantHeartbeat(): void {
            clearInterval(participantHeartbeat);
            participantHeartbeat = undefined;
        }

        function setBoardContext(next: SocketBoardContext | null): void {
            boardContext = next;
            boardContextVersion += 1;
            lastTickId = -1;
            if (next) {
                startParticipantHeartbeat();
            } else {
                stopParticipantHeartbeat();
            }
        }

        function getBoardContext(): SocketBoardContext | null {
            return boardContext;
        }

        function takeContextSnapshot(expectedBoardId?: string): ContextSnapshot | null {
            if (!boardContext) {
                return null;
            }
            if (expectedBoardId && boardContext.boardId !== expectedBoardId) {
                return null;
            }
            return { context: boardContext, version: boardContextVersion };
        }

        function isSnapshotActive(snapshot: ContextSnapshot): boolean {
            if (!socket.connected || !boardContext) {
                return false;
            }
            if (snapshot.version !== boardContextVersion) {
                return false;
            }
            return (
                snapshot.context.boardId === boardContext.boardId
        && snapshot.context.sessionId === boardContext.sessionId
            );
        }

        function startJoinAttempt(): number {
            latestJoinAttempt += 1;
            return latestJoinAttempt;
        }

        function isJoinActive(joinAttempt: number): boolean {
            return socket.connected && joinAttempt === latestJoinAttempt;
        }

        function getIdentity(): SocketIdentity | null {
            return identity;
        }

        function setIdentity(nextIdentity: SocketIdentity): void {
            identity = nextIdentity;
        }

        function getLastTickId(): number {
            return lastTickId;
        }

        function setLastTickId(tickId: number): void {
            lastTickId = tickId;
        }

        function shouldWriteActivity(): boolean {
            const now = Date.now();
            const lastWriteAt = lastActivityWriteAtBySocketId.get(socket.id) ?? 0;
            const jitter = activityJitterBySocketId.get(socket.id)
        ?? Math.floor(Math.random() * (activityWriteJitterMs + 1));
            activityJitterBySocketId.set(socket.id, jitter);
            const effectiveWindow = Math.max(0, activityWriteThrottleMs + jitter);

            if ((now - lastWriteAt) >= effectiveWindow) {
                lastActivityWriteAtBySocketId.set(socket.id, now);
                return true;
            }

            return false;
        }

        async function refreshSocketActivity(snapshot: ContextSnapshot, forceWrite = false): Promise<void> {
            if (!forceWrite && !shouldWriteActivity()) {
                return;
            }

            await deps.boardStateService.touchViewerSession(snapshot.context.boardId, snapshot.context.sessionId);
            await deps.boardStateService.trackClient(snapshot.context.boardId, snapshot.context.userId, socket.id);
            await participantsStore.touchParticipant(snapshot.context.boardId, socket.id);
        }

        async function cleanupBoardRealtimeStateIfEmpty(boardId: string): Promise<void> {
            // Cross-node note: two replicas can both observe size 0 on
            // simultaneous disconnects. Double flush of per-process tick/CRDT
            // buffers is harmless (each node flushes only its own buffer);
            // persistBoard is epoch-guarded and flushBoard takes the eviction
            // lock, so no additional coordination is needed here.
            if (await participantsStore.getRoomSize(boardId) > 0) {
                return;
            }

            await tickPersistence.flushTickMoves(boardId);
            await crdtStore.flushNow(boardId);
            tickPersistence.clearBoard(boardId);
            crdtStore.clearRoom(boardId);
        }

        async function persistBoardOnGlobalDrain(boardId: string): Promise<void> {
            const globalClientCount = await deps.boardStateService.getClientCount(boardId);
            if (globalClientCount <= 1) {
                await deps.boardStateService.persistBoard(boardId);
            }
        }

        async function detachFromBoard(context: SocketBoardContext, broadcastLeave: boolean): Promise<void> {
            // Invalidate first so in-flight handlers and the participant
            // heartbeat cannot keep touching a board this socket left.
            setBoardContext(null);

            await deps.boardStateService.removeClient(context.boardId, context.userId, socket.id);
            await deps.boardStateService.removeViewerSession(context.boardId, context.sessionId);

            const participant = await participantsStore.removeParticipant(context.boardId, socket.id);
            if (broadcastLeave && participant) {
                emitUserLeft(context.boardId, participant);
            }
            socket.leave(context.boardId);
            await cleanupBoardRealtimeStateIfEmpty(context.boardId);
            await persistBoardOnGlobalDrain(context.boardId);
        }

        function cleanupConnectionState(): void {
            lastActivityWriteAtBySocketId.delete(socket.id);
            activityJitterBySocketId.delete(socket.id);
            stopParticipantHeartbeat();
        }

        const runtime: SocketIoHandlerRuntime = {
            socket,
            deps,
            participantsStore,
            tickPersistence,
            crdtStore,
            setBoardContext,
            getBoardContext,
            takeContextSnapshot,
            isSnapshotActive,
            startJoinAttempt,
            isJoinActive,
            getIdentity,
            setIdentity,
            getLastTickId,
            setLastTickId,
            refreshSocketActivity,
            detachFromBoard,
            safeEmitToSelf,
            safeEmitToBoard,
        };

        type SocketServerEvent = (typeof SOCKET_CLIENT_EVENTS)[keyof typeof SOCKET_CLIENT_EVENTS]
            | typeof SOCKET_RESERVED_EVENTS.DISCONNECT;

        /** Error-bounded emits: one failing broadcast must not kill the handler loop. */
        function safeEmitToSelf(event: string, payload: unknown): void {
            try {
                socket.emit(event, payload);
            } catch (error) {
                logger.warn({ err: error, event, socketId: socket.id }, '[socketio] emit failed');
            }
        }

        function safeEmitToBoard(boardId: string, event: string, payload: unknown): void {
            try {
                socket.to(boardId).emit(event, payload);
            } catch (error) {
                logger.warn({ err: error, event, boardId }, '[socketio] board emit failed');
            }
        }

        function registerHandler(event: SocketServerEvent, handler: (payload: unknown) => Promise<void>): void {
            if (event === SOCKET_RESERVED_EVENTS.DISCONNECT) {
                socket.on(event, (payload: unknown) => {
                    void (async () => {
                        try {
                            await handler(payload);
                        } catch (error) {
                            logger.error({ err: error, event, socketId: socket.id }, '[socketio] unhandled disconnect-handler error');
                        }
                    })();
                });
                return;
            }

            socket.on(event, (payload: unknown) => {
                deps.metrics?.incrementCounter('socketio_client_events_total', 1, { event });

                if (!consumeEventToken()) {
                    deps.metrics?.incrementCounter('socketio_throttled_events_total', 1, { event });
                    safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Too many realtime events' });
                    return;
                }

                if (payloadExceedsCap(event, payload)) {
                    deps.metrics?.incrementCounter('socketio_throttled_events_total', 1, { event });
                    safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Realtime payload too large' });
                    return;
                }

                const startedAt = process.hrtime.bigint();
                void (async () => {
                    try {
                        await handler(payload);
                    } catch (error) {
                        deps.metrics?.incrementCounter('socketio_handler_errors_total', 1, { event });
                        logger.error({
                            err: error,
                            event,
                            socketId: socket.id,
                        }, '[socketio] unhandled handler error');
                        if (socket.connected) {
                            safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Internal realtime server error' });
                        }
                    } finally {
                        deps.metrics?.observeDuration(
                            'socketio_handler_duration_seconds',
                            Number(process.hrtime.bigint() - startedAt) / 1e9,
                            { event },
                        );
                    }
                })();
            });
        }

        registerHandler(SOCKET_CLIENT_EVENTS.BOARD_JOIN, createBoardJoinHandler(runtime));
        registerHandler(SOCKET_CLIENT_EVENTS.MUTATION_BATCH, createMutationBatchHandler(runtime));
        registerHandler(SOCKET_CLIENT_EVENTS.CRDT_UPDATE, createCrdtUpdateHandler(runtime));
        registerHandler(SOCKET_CLIENT_EVENTS.PRESENCE_UPDATE, createPresenceUpdateHandler(runtime));
        registerHandler(SOCKET_CLIENT_EVENTS.REALTIME_TICK, createRealtimeTickHandler(runtime));
        registerHandler(SOCKET_RESERVED_EVENTS.DISCONNECT, createDisconnectHandler(runtime, cleanupConnectionState));
    });

    return io;
}
