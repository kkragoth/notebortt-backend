import type { Database } from '../../db/client.js'
import { createWorkspaceCore } from './core.js'
import { createWorkspaceInvitations } from './invitations.js'

export { WorkspaceInvitationError } from './common.js'

export function createWorkspaceService(db: Database) {
  const core = createWorkspaceCore(db)
  const invitations = createWorkspaceInvitations(db)

  return {
    ...core,
    ...invitations,
  }
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>
