import type { Database } from '@/db/client.js';
import { createWorkspaceCore } from '@/services/workspace/core.js';
import { createWorkspaceInvitations } from '@/services/workspace/invitations.js';

export { WorkspaceInvitationError } from '@/services/workspace/common.js';

export function createWorkspaceService(db: Database) {
    const core = createWorkspaceCore(db);
    const invitations = createWorkspaceInvitations(db);

    return {
        ...core,
        ...invitations,
    };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>
