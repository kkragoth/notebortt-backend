import { getUserColor } from '../../socketio/user-color.js';
import { resolveSocketIdentity } from '../../socketio/identity.js';
import { parseBoardJoinPayload } from '../../socketio/payloads.js';
import { SOCKET_SERVER_EVENTS } from '../../socketio/constants.js';
import { SOCKET_ROOM_CONNECTION_CAP } from '../../socketio/limits.js';
import type { SocketIoHandlerRuntime } from '../../socketio/handlers/runtime.js';

export function createBoardJoinHandler(runtime: SocketIoHandlerRuntime) {
    return async (rawPayload: unknown): Promise<void> => {
        const payload = parseBoardJoinPayload(rawPayload);
        if (!payload) {
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Invalid board join payload' });
            return;
        }

        const joinAttempt = runtime.startJoinAttempt();
        const identity = runtime.getIdentity() ?? await resolveIdentity(runtime, joinAttempt);
        if (!identity || !runtime.isJoinActive(joinAttempt)) {
            return;
        }

        // Anonymous visitors can self-identify with a display name (e.g. "Anonymous
        // Fox") that other participants see in presence. Authenticated users always
        // use their profile name.
        const isAnonymous = identity.authUserId === undefined;
        const userName = isAnonymous && payload.userName ? payload.userName : identity.userName;

        const shareToken = payload.shareToken ?? (typeof runtime.socket.handshake.query.shareToken === 'string'
            ? runtime.socket.handshake.query.shareToken
            : undefined);
        const access = await runtime.deps.boardService.checkBoardAccess(payload.boardId, identity.authUserId, shareToken);
        if (!runtime.isJoinActive(joinAttempt)) {
            return;
        }
        if (!access.hasAccess) {
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'No access to board' });
            return;
        }

        // Fast rejection path: a full room that this socket has not joined yet.
        // (The authoritative cap check happens atomically at admission below.)
        // One prune + one pipeline answers both questions instead of two
        // independently-pruning reads.
        const { isMember: isAlreadyParticipant, size: currentRoomSize } =
            await runtime.participantsStore.getAdmissionState(payload.boardId, runtime.socket.id);
        if (!runtime.isJoinActive(joinAttempt)) {
            return;
        }
        if (!isAlreadyParticipant && currentRoomSize >= SOCKET_ROOM_CONNECTION_CAP) {
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Board room is full' });
            return;
        }

        const previousContext = runtime.getBoardContext();
        const shouldDetachPreviousContext = previousContext
      && (previousContext.boardId !== payload.boardId || previousContext.sessionId !== payload.sessionId);
        if (previousContext && shouldDetachPreviousContext) {
            await runtime.detachFromBoard(previousContext, true);
        }

        await runtime.deps.boardStateService.loadBoard(payload.boardId);
        if (!runtime.isJoinActive(joinAttempt)) {
            return;
        }
        await runtime.deps.boardStateService.trackClient(payload.boardId, identity.runtimeUserId, runtime.socket.id);
        if (!runtime.isJoinActive(joinAttempt)) {
            return;
        }
        await runtime.deps.boardStateService.touchViewerSession(payload.boardId, payload.sessionId);
        if (!runtime.isJoinActive(joinAttempt)) {
            return;
        }

        runtime.socket.join(payload.boardId);
        const color = getUserColor(identity.runtimeUserId);
        runtime.setBoardContext({
            boardId: payload.boardId,
            permission: access.permission === 'edit' ? 'edit' : 'view',
            sessionId: payload.sessionId,
            userId: identity.runtimeUserId,
            userName,
            avatarUrl: identity.avatarUrl,
            color,
        });

        const participants = await runtime.participantsStore.getRoomParticipants(payload.boardId);
        for (const existingParticipant of participants) {
            if (existingParticipant.sessionId === payload.sessionId) {
                continue;
            }
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.USER_JOINED, existingParticipant);
        }

        // Atomic admission: enforces the room cap even under concurrent joins
        // and doubles as the participant write. A socket that already holds a
        // slot (session refresh / permission re-join) always re-admits.
        const admitted = await runtime.participantsStore.admitParticipant(
            payload.boardId,
            runtime.socket.id,
            {
                sessionId: payload.sessionId,
                userId: identity.runtimeUserId,
                userName,
                avatarUrl: identity.avatarUrl,
                color,
            },
            SOCKET_ROOM_CONNECTION_CAP,
        );
        if (!admitted) {
            runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.SYNC_ERROR, { message: 'Board room is full' });
            const context = runtime.getBoardContext();
            if (context && context.boardId === payload.boardId) {
                await runtime.detachFromBoard(context, false);
            }
            return;
        }
        if (!runtime.isJoinActive(joinAttempt)) {
            return;
        }

        runtime.safeEmitToBoard(payload.boardId, SOCKET_SERVER_EVENTS.USER_JOINED, {
            sessionId: payload.sessionId,
            userId: identity.runtimeUserId,
            userName,
            avatarUrl: identity.avatarUrl,
            color,
        });

        const snapshot = await runtime.deps.boardStateService.getSnapshot(payload.boardId);
        const currentContext = runtime.getBoardContext();
        if (!runtime.isJoinActive(joinAttempt) || !currentContext || currentContext.sessionId !== payload.sessionId) {
            return;
        }

        runtime.safeEmitToSelf(SOCKET_SERVER_EVENTS.BOARD_SNAPSHOT, {
            elements: snapshot.elements,
            lastSequence: snapshot.sequence,
        });
    };
}

async function resolveIdentity(runtime: SocketIoHandlerRuntime, joinAttempt: number) {
    const identity = await resolveSocketIdentity(runtime.socket, runtime.deps);
    if (!identity || !runtime.isJoinActive(joinAttempt)) {
        return null;
    }
    runtime.setIdentity(identity);
    return identity;
}
