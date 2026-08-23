import { createBoardInvitationTransitions } from '../domain/invitation-transitions.js';
import { createPendingInviteReadModel } from '../domain/pending-invites.js';
import type { Database } from '@/platform/db/client.js';

export function createBoardInvitations(db: Database) {
    const transitions = createBoardInvitationTransitions(db);
    const readModel = createPendingInviteReadModel(db);

    return {
        ...transitions,
        ...readModel,
    };
}
