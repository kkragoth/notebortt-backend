import { createWorkspaceCore } from '../workspace/core.js';
import { createWorkspaceInvitations } from '../workspace/invitations.js';
import type { Database } from '@/platform/db/client.js';

export { WorkspaceInvitationError } from '../workspace/common.js';

export function createWorkspaceService(db: Database) {
    const core = createWorkspaceCore(db);
    const invitations = createWorkspaceInvitations(db);

    return {
        ...core,
        ...invitations,
    };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>
