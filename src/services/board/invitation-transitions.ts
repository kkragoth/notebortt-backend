import { and, eq, gt, inArray, ne } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { boardInvitations, boardMembers, users, workspaceInvitations } from '../../db/schema.js'
import { INVITATION_STATUS_ACCEPTED, INVITATION_STATUS_PENDING, INVITATION_STATUS_REVOKED, type BoardPermission } from '../board.service.constants.js'
import { normalizeEmail } from '../board.service.utils.js'
import { buildInvitationExpiry, generateInvitationToken, isUniqueViolation } from './helpers.js'

export function createBoardInvitationTransitions(db: Database) {
  async function getUserEmail(userId: string) {
    const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
    const email = rows[0]?.email
    if (!email) {
      throw new Error('User not found')
    }
    return email
  }

  async function getPendingBoardInvitation(boardId: string, emailLower: string) {
    const rows = await db
      .select({ id: boardInvitations.id, token: boardInvitations.token })
      .from(boardInvitations)
      .where(and(eq(boardInvitations.boardId, boardId), eq(boardInvitations.emailLower, emailLower), eq(boardInvitations.status, INVITATION_STATUS_PENDING)))
      .limit(1)

    return rows[0] ?? null
  }

  async function createBoardInvitation(boardId: string, invitedBy: string, email: string, permission: BoardPermission) {
    const emailLower = normalizeEmail(email)
    const existingPending = await getPendingBoardInvitation(boardId, emailLower)
    if (existingPending) {
      return { inviteId: existingPending.id, token: existingPending.token }
    }

    try {
      const [invitation] = await db
        .insert(boardInvitations)
        .values({ boardId, invitedBy, emailLower, permission, status: INVITATION_STATUS_PENDING, token: generateInvitationToken(), expiresAt: buildInvitationExpiry() })
        .returning({ id: boardInvitations.id, token: boardInvitations.token })

      return { inviteId: invitation!.id, token: invitation!.token }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const pendingInvitation = await getPendingBoardInvitation(boardId, emailLower)
        if (pendingInvitation) {
          return { inviteId: pendingInvitation.id, token: pendingInvitation.token }
        }
      }
      throw error
    }
  }

  async function acceptBoardInvitationByToken(token: string, userId: string) {
    const emailLower = normalizeEmail(await getUserEmail(userId))

    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: boardInvitations.id, boardId: boardInvitations.boardId, invitedBy: boardInvitations.invitedBy, permission: boardInvitations.permission })
        .from(boardInvitations)
        .where(and(eq(boardInvitations.token, token), eq(boardInvitations.emailLower, emailLower)))
        .limit(1)

      const invitation = rows[0]
      if (!invitation) {
        throw new Error('Invitation not found')
      }

      const accepted = await tx
        .update(boardInvitations)
        .set({ status: INVITATION_STATUS_ACCEPTED, respondedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(boardInvitations.id, invitation.id), eq(boardInvitations.status, INVITATION_STATUS_PENDING), gt(boardInvitations.expiresAt, new Date())))
        .returning({ id: boardInvitations.id })

      if (accepted.length === 0) {
        throw new Error('Invitation expired or already used')
      }

      await tx
        .insert(boardMembers)
        .values({ boardId: invitation.boardId, userId, permission: invitation.permission, addedBy: invitation.invitedBy, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [boardMembers.boardId, boardMembers.userId],
          set: { permission: invitation.permission, updatedAt: new Date() },
        })
    })
  }

  async function declinePendingInvitationByToken(token: string, userId: string) {
    const emailLower = normalizeEmail(await getUserEmail(userId))

    return db.transaction(async (tx) => {
      const boardRows = await tx
        .select({ id: boardInvitations.id })
        .from(boardInvitations)
        .where(and(eq(boardInvitations.token, token), eq(boardInvitations.emailLower, emailLower), eq(boardInvitations.status, INVITATION_STATUS_PENDING)))
        .limit(1)

      const boardInvitation = boardRows[0]
      if (boardInvitation) {
        await tx
          .update(boardInvitations)
          .set({ status: INVITATION_STATUS_REVOKED, respondedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(boardInvitations.id, boardInvitation.id), eq(boardInvitations.status, INVITATION_STATUS_PENDING)))
        return
      }

      const workspaceRows = await tx
        .select({ id: workspaceInvitations.id })
        .from(workspaceInvitations)
        .where(and(eq(workspaceInvitations.token, token), eq(workspaceInvitations.emailLower, emailLower), eq(workspaceInvitations.status, INVITATION_STATUS_PENDING)))
        .limit(1)

      const workspaceInvitation = workspaceRows[0]
      if (!workspaceInvitation) {
        throw new Error('Invitation not found')
      }

      await tx
        .update(workspaceInvitations)
        .set({ status: 'declined', respondedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workspaceInvitations.id, workspaceInvitation.id), eq(workspaceInvitations.status, INVITATION_STATUS_PENDING)))
    })
  }

  async function revokeBoardInvitation(boardId: string, inviteId: string) {
    await db
      .update(boardInvitations)
      .set({ status: INVITATION_STATUS_REVOKED, respondedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(boardInvitations.id, inviteId), eq(boardInvitations.boardId, boardId), eq(boardInvitations.status, INVITATION_STATUS_PENDING)))
  }

  async function getBoardInvitationIds(boardId: string) {
    const rows = await db.select({ id: boardInvitations.id }).from(boardInvitations).where(eq(boardInvitations.boardId, boardId))
    return rows.map((row) => row.id)
  }

  async function expireInvitations(inviteIds: string[]) {
    if (inviteIds.length === 0) {
      return
    }

    await db
      .update(boardInvitations)
      .set({ status: 'expired', respondedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(boardInvitations.id, inviteIds), ne(boardInvitations.status, 'accepted')))
  }

  return { createBoardInvitation, acceptBoardInvitationByToken, declinePendingInvitationByToken, revokeBoardInvitation, getBoardInvitationIds, expireInvitations }
}
