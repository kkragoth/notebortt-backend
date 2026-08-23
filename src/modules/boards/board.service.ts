import { createBoardInvitations } from './/domain/invitations.js';
import { createBoardLifecycle } from './/domain/lifecycle.js';
import { createBoardMembers } from './/domain/members.js';
import { createBoardQueries } from './/domain/queries.js';
import { createBoardSharing } from './/domain/sharing.js';
import type { Database } from '@/platform/db/client.js';

export function createBoardService(db: Database) {
    const queries = createBoardQueries(db);
    const lifecycle = createBoardLifecycle(db);
    const members = createBoardMembers(db);
    const invitations = createBoardInvitations(db);
    const sharing = createBoardSharing(db, queries);

    return {
        ...lifecycle,
        ...queries,
        ...members,
        ...invitations,
        ...sharing,
    };
}

export type BoardService = ReturnType<typeof createBoardService>
