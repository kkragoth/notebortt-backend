import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createCrdtRoomStore } from '../socketio/crdt-room.js';
import { createParticipantsStore } from '../socketio/participants.js';
import { createTickPersistenceManager } from '../socketio/tick-persistence.js';
import {
    SOCKET_CLIENT_EVENTS,
    SOCKET_RESERVED_EVENTS,
    SOCKET_SERVER_EVENTS,
    WS_ELEMENTS_CHANGED_TYPE,
    boardMutationsChannel,
} from '../socketio/constants.js';
import { createBoardJoinHandler } from '../socketio/handlers/join.handler.js';
import { createMutationBatchHandler } from '../socketio/handlers/mutation-batch.handler.js';
import { createCrdtUpdateHandler } from '../socketio/handlers/crdt-update.handler.js';
import { createPresenceUpdateHandler } from '../socketio/handlers/presence-update.handler.js';
import { createRealtimeTickHandler } from '../socketio/handlers/realtime-tick.handler.js';
import { createDisconnectHandler } from '../socketio/handlers/disconnect.handler.js';
import {
    decrementOpenSocketIoConnections,
    incrementOpenSocketIoConnections,
} from '../socketio/stats.js';
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

const DEFAULT_ACTIVITY_WRITE_THROTTLE_MS = 3_000;
const DEFAULT_ACTIVITY_WRITE_JITTER_MS = 400;
// Well under the participants store TTL so three missed beats still survive.
const DEFAULT_PARTICIPANT_HEARTBEAT_MS = 30_000;

function parseAllowedOrigins(raw: string): string[] {
    return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
}

export function createSocketIoRealtimeServer(
    httpServer: HttpServer,
    deps: SocketIoRealtimeDependencies,
    options: SocketIoRealtimeServerOptions,
) {
    const io = new Server(httpServer, {
        transports: ['websocket'],
        cors: {
            origin: parseAllowedOrigins(options.corsOrigin),
            credentials: true,
        },
    });

    // Cross-replica broadcasting (rooms, USER_JOINED/LEFT, element changes)
    // requires the redis adapter once more than one realtime replica runs.
    io.adapter(createAdapter(deps.pubRedis, deps.subRedis));

    async function publishElementsChanged(boardId: string, userId: string, change: unknown, senderId: string): Promise<void> {
        await deps.pubRedis.publish(
            boardMutationsChannel(boardId),
            JSON.stringify({
                message: { type: WS_ELEMENTS_CHANGED_TYPE, change, fromUserId: userId },
                senderConnectionId: `socketio:${senderId}`,
            }),
        );
    }

    const participantsStore = createParticipantsStore(deps.pubRedis);
    const tickPersistence = createTickPersistenceManager(deps, { onPersistedChange: publishElementsChanged });
    const crdtStore = createCrdtRoomStore(deps.boardStateService, deps.mutationProcessor, {
        debounceMs: options.crdtDebounceMs,
        maxWaitMs: options.crdtMaxWaitMs,
        onPersistedChange: async (boardId, userId, change) => {
            await deps.pubRedis.publish(
                boardMutationsChannel(boardId),
                JSON.stringify({
                    message: { type: WS_ELEMENTS_CHANGED_TYPE, change, fromUserId: userId },
                    senderConnectionId: `socketio:crdt:${boardId}`,
                }),
            );
        },
    });

    function emitUserLeft(boardId: string, participant: RoomParticipant): void {
        io.to(boardId).emit(SOCKET_SERVER_EVENTS.USER_LEFT, {
            sessionId: participant.sessionId,
            userId: participant.userId,
        });
    }

    io.on(SOCKET_RESERVED_EVENTS.CONNECTION, (socket) => {
        incrementOpenSocketIoConnections();
        socket.once(SOCKET_RESERVED_EVENTS.DISCONNECT, () => {
            decrementOpenSocketIoConnections();
        });

        let boardContext: SocketBoardContext | null = null;
        let boardContextVersion = 0;
        let identity: SocketIdentity | null = null;
        let lastTickId = -1;
        let latestJoinAttempt = 0;
        const lastActivityWriteAtBySocketId = new Map<string, number>();
        const activityJitterBySocketId = new Map<string, number>();
        // Keeps the redis participant entry alive even for idle-but-connected
        // sockets: activity-based refresh alone would expire quiet users after
        // PARTICIPANT_TTL_MS and corrupt rosters / room-size checks.
        const participantHeartbeat = setInterval(() => {
            if (boardContext && socket.connected) {
                void participantsStore.touchParticipant(boardContext.boardId, socket.id);
            }
        }, DEFAULT_PARTICIPANT_HEARTBEAT_MS);
        participantHeartbeat.unref();

        function setBoardContext(next: SocketBoardContext | null): void {
            boardContext = next;
            boardContextVersion += 1;
            lastTickId = -1;
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
        ?? Math.floor(Math.random() * (DEFAULT_ACTIVITY_WRITE_JITTER_MS + 1));
            activityJitterBySocketId.set(socket.id, jitter);
            const effectiveWindow = Math.max(0, DEFAULT_ACTIVITY_WRITE_THROTTLE_MS + jitter);

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
            clearInterval(participantHeartbeat);
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
            publishElementsChanged,
        };

        type SocketServerEvent = (typeof SOCKET_CLIENT_EVENTS)[keyof typeof SOCKET_CLIENT_EVENTS]
            | typeof SOCKET_RESERVED_EVENTS.DISCONNECT;

        function registerHandler(event: SocketServerEvent, handler: (payload: unknown) => Promise<void>): void {
            socket.on(event, (payload: unknown) => {
                void (async () => {
                    try {
                        await handler(payload);
                    } catch (error) {
                        logger.error({
                            err: error,
                            event,
                            socketId: socket.id,
                        }, '[socketio] unhandled handler error');
                        if (socket.connected) {
                            socket.emit(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Internal realtime server error' });
                        }
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
