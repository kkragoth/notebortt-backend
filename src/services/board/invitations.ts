import type { Database } from '../../db/client.js'
import { createBoardInvitationTransitions } from './invitation-transitions.js'
import { createPendingInviteReadModel } from './pending-invites.js'

export function createBoardInvitations(db: Database) {
  const transitions = createBoardInvitationTransitions(db)
  const readModel = createPendingInviteReadModel(db)

  return {
    ...transitions,
    ...readModel,
  }
}
