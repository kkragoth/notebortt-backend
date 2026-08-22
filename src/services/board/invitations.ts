import type { Database } from '@/db/client.js';
import { createBoardInvitationTransitions } from '@/services/board/invitation-transitions.js';
import { createPendingInviteReadModel } from '@/services/board/pending-invites.js';

export function createBoardInvitations(db: Database) {
    const transitions = createBoardInvitationTransitions(db);
    const readModel = createPendingInviteReadModel(db);

    return {
        ...transitions,
        ...readModel,
    };
}
