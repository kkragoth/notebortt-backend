import type { Database } from '../db/client.js'
import { createBoardInvitations } from './board/invitations.js'
import { createBoardLifecycle } from './board/lifecycle.js'
import { createBoardMembers } from './board/members.js'
import { createBoardQueries } from './board/queries.js'
import { createBoardSharing } from './board/sharing.js'

export function createBoardService(db: Database) {
  const queries = createBoardQueries(db)
  const lifecycle = createBoardLifecycle(db)
  const members = createBoardMembers(db)
  const invitations = createBoardInvitations(db)
  const sharing = createBoardSharing(db, queries)

  return {
    ...lifecycle,
    ...queries,
    ...members,
    ...invitations,
    ...sharing,
  }
}

export type BoardService = ReturnType<typeof createBoardService>
