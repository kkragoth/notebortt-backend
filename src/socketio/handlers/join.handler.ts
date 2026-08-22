import type { SocketIoHandlerRuntime } from '@/socketio/handlers/runtime.js';
import { getUserColor } from '@/ws/room.js';
import { resolveSocketIdentity } from '@/socketio/identity.js';
import { parseBoardJoinPayload } from '@/socketio/payloads.js';

export function createBoardJoinHandler(runtime: SocketIoHandlerRuntime) {
    return async (rawPayload: unknown): Promise<void> => {
        const payload = parseBoardJoinPayload(rawPayload);
        if (!payload) {
            runtime.socket.emit('sync:error', { message: 'Invalid board join payload' });
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
            runtime.socket.emit('sync:error', { message: 'No access to board' });
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

        const participants = runtime.participantsStore.getRoomParticipants(payload.boardId);
        for (const existingParticipant of participants.values()) {
            if (existingParticipant.sessionId === payload.sessionId) {
                continue;
            }
            runtime.socket.emit('USER_JOINED', existingParticipant);
        }

        runtime.participantsStore.setParticipant(payload.boardId, runtime.socket.id, {
            sessionId: payload.sessionId,
            userId: identity.runtimeUserId,
            userName,
            avatarUrl: identity.avatarUrl,
            color,
        });

        runtime.socket.to(payload.boardId).emit('USER_JOINED', {
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

        runtime.socket.emit('board:snapshot', {
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
