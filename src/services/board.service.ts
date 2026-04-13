import { randomBytes } from 'crypto'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boardFavorites, boardInvitations, boardMembers, boards, elements, users, workspaceInvitations, workspaceMembers, workspaces } from '../db/schema.js'
import {
  BOARD_PERMISSION_EDIT,
  BOARD_PERMISSION_VIEW,
  INVITATION_STATUS_ACCEPTED,
  INVITATION_STATUS_PENDING,
  INVITATION_STATUS_REVOKED,
  type BoardPermission,
} from './board.service.constants.js'
import { buildDuplicatedElements, normalizeEmail, workspaceRoleToBoardPermission } from './board.service.utils.js'

const INVITATION_TOKEN_BYTES = 32
const INVITATION_EXPIRES_DAYS = 7
const POSTGRES_UNDEFINED_TABLE = '42P01'

function isMissingRelationError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === POSTGRES_UNDEFINED_TABLE
}

function buildInvitationExpiry(): Date {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRES_DAYS)
  return expiresAt
}

function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString('hex')
}

function generateLinkShareToken(): string {
  return randomBytes(24).toString('hex')
}

export function createBoardService(db: Database) {
  type AccessibleBoard = typeof boards.$inferSelect & {
    permission: BoardPermission
    accessSource: 'workspace' | 'board_member'
    isFavorite: boolean
    favoriteCreatedAt: Date | null
  }

  async function getFavoriteBoardMap(userId: string) {
    try {
      const rows = await db
        .select({
          boardId: boardFavorites.boardId,
          createdAt: boardFavorites.createdAt,
        })
        .from(boardFavorites)
        .where(eq(boardFavorites.userId, userId))

      return new Map(rows.map((row) => [row.boardId, row.createdAt ?? null] as const))
    } catch (error) {
      if (isMissingRelationError(error)) {
        return new Map<string, Date | null>()
      }

      throw error
    }
  }

  async function getBoard(boardId: string, userId?: string) {
    const result = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1)
    const board = result[0] ?? null
    if (!board) {
      return null
    }

    const favoriteCreatedAt = userId ? await getBoardFavoriteCreatedAt(boardId, userId) : null
    return {
      ...board,
      isFavorite: favoriteCreatedAt !== null,
      favoriteCreatedAt,
    }
  }

  async function getBoardFavoriteCreatedAt(boardId: string, userId: string) {
    const rows = await db
      .select({ createdAt: boardFavorites.createdAt })
      .from(boardFavorites)
      .where(and(eq(boardFavorites.boardId, boardId), eq(boardFavorites.userId, userId)))
      .limit(1)

    return rows[0]?.createdAt ?? null
  }

  async function getBoardMemberPermission(boardId: string, userId: string) {
    const rows = await db
      .select({ permission: boardMembers.permission })
      .from(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
      .limit(1)

    return rows[0]?.permission as BoardPermission | undefined
  }

  async function getWorkspaceBoardMembershipPermission(workspaceId: string, userId: string): Promise<BoardPermission | null> {
    const rows = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1)

    if (rows.length === 0) {
      return null
    }

    return workspaceRoleToBoardPermission(rows[0]!.role)
  }

  async function createBoard(workspaceId: string, name: string) {
    const [board] = await db.insert(boards).values({ workspaceId, name }).returning()
    return board
  }

  async function getBoardsForWorkspace(workspaceId: string, userId: string) {
    const favoriteBoardMap = await getFavoriteBoardMap(userId)
    const rows = await db.select().from(boards).where(eq(boards.workspaceId, workspaceId))

    return rows.map((board) => ({
      ...board,
      isFavorite: favoriteBoardMap.has(board.id),
      favoriteCreatedAt: favoriteBoardMap.get(board.id) ?? null,
    }))
  }

  async function listAccessibleBoards(userId: string): Promise<AccessibleBoard[]> {
    const favoriteBoardMap = await getFavoriteBoardMap(userId)

    const workspaceBoards = await db
      .select({
        id: boards.id,
        workspaceId: boards.workspaceId,
        name: boards.name,
        currentCommitId: boards.currentCommitId,
        currentBranch: boards.currentBranch,
        previewSvg: boards.previewSvg,
        previewVersion: boards.previewVersion,
        previewUpdatedAt: boards.previewUpdatedAt,
        linkShareEnabled: boards.linkShareEnabled,
        linkShareToken: boards.linkShareToken,
        linkSharePermission: boards.linkSharePermission,
        createdAt: boards.createdAt,
        updatedAt: boards.updatedAt,
        permission: workspaceMembers.role,
      })
      .from(boards)
      .innerJoin(workspaceMembers, and(
        eq(boards.workspaceId, workspaceMembers.workspaceId),
        eq(workspaceMembers.userId, userId),
      ))

    const directBoardMembers = await db
      .select({
        id: boards.id,
        workspaceId: boards.workspaceId,
        name: boards.name,
        currentCommitId: boards.currentCommitId,
        currentBranch: boards.currentBranch,
        previewSvg: boards.previewSvg,
        previewVersion: boards.previewVersion,
        previewUpdatedAt: boards.previewUpdatedAt,
        linkShareEnabled: boards.linkShareEnabled,
        linkShareToken: boards.linkShareToken,
        linkSharePermission: boards.linkSharePermission,
        createdAt: boards.createdAt,
        updatedAt: boards.updatedAt,
        permission: boardMembers.permission,
      })
      .from(boards)
      .innerJoin(boardMembers, and(
        eq(boards.id, boardMembers.boardId),
        eq(boardMembers.userId, userId),
      ))

    const deduped = new Map<string, AccessibleBoard>()

    for (const board of workspaceBoards) {
      deduped.set(board.id, {
        ...board,
        permission: workspaceRoleToBoardPermission(board.permission),
        accessSource: 'workspace',
        isFavorite: favoriteBoardMap.has(board.id),
        favoriteCreatedAt: favoriteBoardMap.get(board.id) ?? null,
      })
    }

    for (const board of directBoardMembers) {
      if (deduped.has(board.id)) {
        continue
      }

      deduped.set(board.id, {
        ...board,
        permission: board.permission === BOARD_PERMISSION_EDIT ? BOARD_PERMISSION_EDIT : BOARD_PERMISSION_VIEW,
        accessSource: 'board_member',
        isFavorite: favoriteBoardMap.has(board.id),
        favoriteCreatedAt: favoriteBoardMap.get(board.id) ?? null,
      })
    }

    return Array.from(deduped.values())
  }

  async function getBoardElements(boardId: string): Promise<Record<string, { id: string; type: string; data: unknown; updatedAt: Date | null }>> {
    const rows = await db
      .select({
        id: elements.id,
        type: elements.type,
        data: elements.data,
        updatedAt: elements.updatedAt,
      })
      .from(elements)
      .where(eq(elements.boardId, boardId))

    return Object.fromEntries(rows.map((row) => [row.id, row]))
  }

  async function checkBoardAccess(
    boardId: string,
    userId: string | undefined,
    shareToken?: string,
  ): Promise<{ hasAccess: boolean; permission: BoardPermission | null }> {
    const board = await getBoard(boardId)
    if (!board) {
      return { hasAccess: false, permission: null }
    }

    if (shareToken && board.linkShareEnabled && board.linkShareToken === shareToken) {
      return { hasAccess: true, permission: board.linkSharePermission as BoardPermission }
    }

    if (userId) {
      const directPermission = await getBoardMemberPermission(boardId, userId)
      if (directPermission) {
        return { hasAccess: true, permission: directPermission }
      }

      const workspacePermission = await getWorkspaceBoardMembershipPermission(board.workspaceId, userId)
      if (workspacePermission) {
        return { hasAccess: true, permission: workspacePermission }
      }
    }

    return { hasAccess: false, permission: null }
  }

  async function getBoardMembers(boardId: string) {
    return db.select().from(boardMembers).where(eq(boardMembers.boardId, boardId))
  }

  async function upsertBoardMember(boardId: string, userId: string, permission: BoardPermission, addedBy?: string) {
    const [member] = await db
      .insert(boardMembers)
      .values({ boardId, userId, permission, addedBy: addedBy ?? null })
      .onConflictDoUpdate({
        target: [boardMembers.boardId, boardMembers.userId],
        set: {
          permission,
          addedBy: addedBy ?? null,
          updatedAt: new Date(),
        },
      })
      .returning()

    return member
  }

  async function updateBoardMemberPermission(boardId: string, memberId: string, permission: BoardPermission) {
    await db
      .update(boardMembers)
      .set({ permission, updatedAt: new Date() })
      .where(and(eq(boardMembers.id, memberId), eq(boardMembers.boardId, boardId)))
  }

  async function deleteBoardMember(boardId: string, memberId: string) {
    await db
      .delete(boardMembers)
      .where(and(eq(boardMembers.id, memberId), eq(boardMembers.boardId, boardId)))
  }

  async function setBoardLinkShare(boardId: string, enabled: boolean, permission: BoardPermission) {
    const nextToken = enabled ? generateLinkShareToken() : null

    const [board] = await db
      .update(boards)
      .set({
        linkShareEnabled: enabled,
        linkSharePermission: permission,
        linkShareToken: nextToken,
        updatedAt: new Date(),
      })
      .where(eq(boards.id, boardId))
      .returning({
        id: boards.id,
        linkShareEnabled: boards.linkShareEnabled,
        linkSharePermission: boards.linkSharePermission,
        linkShareToken: boards.linkShareToken,
      })

    return board ?? null
  }

  async function rotateBoardLinkShareToken(boardId: string) {
    const [board] = await db
      .update(boards)
      .set({
        linkShareToken: generateLinkShareToken(),
        updatedAt: new Date(),
      })
      .where(eq(boards.id, boardId))
      .returning({
        id: boards.id,
        linkShareEnabled: boards.linkShareEnabled,
        linkSharePermission: boards.linkSharePermission,
        linkShareToken: boards.linkShareToken,
      })

    return board ?? null
  }

  async function getShareByToken(token: string) {
    const rows = await db
      .select({ boardId: boards.id, permission: boards.linkSharePermission })
      .from(boards)
      .where(and(
        eq(boards.linkShareToken, token),
        eq(boards.linkShareEnabled, true),
      ))
      .limit(1)

    return rows[0] ?? null
  }

  async function createBoardInvitation(boardId: string, invitedBy: string, email: string, permission: BoardPermission) {
    const normalizedEmail = normalizeEmail(email)

    const existingPending = await db
      .select({ id: boardInvitations.id, token: boardInvitations.token })
      .from(boardInvitations)
      .where(and(
        eq(boardInvitations.boardId, boardId),
        eq(boardInvitations.emailLower, normalizedEmail),
        eq(boardInvitations.status, INVITATION_STATUS_PENDING),
      ))
      .limit(1)

    if (existingPending.length > 0) {
      return { inviteId: existingPending[0]!.id, token: existingPending[0]!.token }
    }

    const [invitation] = await db
      .insert(boardInvitations)
      .values({
        boardId,
        invitedBy,
        emailLower: normalizedEmail,
        permission,
        status: INVITATION_STATUS_PENDING,
        token: generateInvitationToken(),
        expiresAt: buildInvitationExpiry(),
      })
      .returning({ id: boardInvitations.id, token: boardInvitations.token })

    return { inviteId: invitation!.id, token: invitation!.token }
  }

  async function listPendingInvitesForUser(userId: string) {
    const userRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const userEmail = userRows[0]?.email
    if (!userEmail) {
      return []
    }

    const boardInvitationsRows = await db
      .select({
        kind: sql`'board'`.as('kind'),
        id: boardInvitations.id,
        token: boardInvitations.token,
        boardId: boardInvitations.boardId,
        boardTitle: boards.name,
        permission: boardInvitations.permission,
        createdAt: boardInvitations.createdAt,
        createdBy: users.name,
        status: boardInvitations.status,
      })
      .from(boardInvitations)
      .innerJoin(boards, eq(boardInvitations.boardId, boards.id))
      .innerJoin(users, eq(boardInvitations.invitedBy, users.id))
      .where(and(
        eq(boardInvitations.emailLower, normalizeEmail(userEmail)),
        eq(boardInvitations.status, INVITATION_STATUS_PENDING),
      ))

    const workspaceInvitationsRows = await db
      .select({
        kind: sql`'workspace'`.as('kind'),
        id: workspaceInvitations.id,
        token: workspaceInvitations.token,
        workspaceId: workspaceInvitations.workspaceId,
        workspaceName: workspaces.name,
        role: workspaceInvitations.role,
        createdAt: workspaceInvitations.createdAt,
        createdBy: users.name,
        status: workspaceInvitations.status,
      })
      .from(workspaceInvitations)
      .innerJoin(workspaces, eq(workspaceInvitations.workspaceId, workspaces.id))
      .innerJoin(users, eq(workspaceInvitations.invitedBy, users.id))
      .where(and(
        eq(workspaceInvitations.emailLower, normalizeEmail(userEmail)),
        eq(workspaceInvitations.status, INVITATION_STATUS_PENDING),
      ))

    return [
      ...boardInvitationsRows.map((invitation) => ({
      id: invitation.id,
      kind: 'board' as const,
      token: invitation.token,
      notificationId: null,
      boardId: invitation.boardId,
      boardTitle: invitation.boardTitle,
      permission: invitation.permission as BoardPermission,
      createdAt: invitation.createdAt ? new Date(invitation.createdAt).getTime() : Date.now(),
      createdBy: invitation.createdBy,
      status: invitation.status as 'pending' | 'accepted' | 'revoked' | 'expired',
      })),
      ...workspaceInvitationsRows.map((invitation) => ({
        id: invitation.id,
        kind: 'workspace' as const,
        token: invitation.token,
        notificationId: null,
        workspaceId: invitation.workspaceId,
        workspaceName: invitation.workspaceName,
        role: invitation.role as 'admin' | 'editor' | 'viewer',
        createdAt: invitation.createdAt ? new Date(invitation.createdAt).getTime() : Date.now(),
        createdBy: invitation.createdBy,
        status: invitation.status as 'pending' | 'accepted' | 'revoked' | 'expired',
      })),
    ]
  }

  async function acceptBoardInvitationByToken(token: string, userId: string) {
    const userRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const userEmail = userRows[0]?.email
    if (!userEmail) {
      throw new Error('User not found')
    }

    return db.transaction(async (tx) => {
      const invitationRows = await tx
        .select()
        .from(boardInvitations)
        .where(and(
          eq(boardInvitations.token, token),
          eq(boardInvitations.emailLower, normalizeEmail(userEmail)),
          eq(boardInvitations.status, INVITATION_STATUS_PENDING),
        ))
        .limit(1)

      const invitation = invitationRows[0]
      if (!invitation) {
        throw new Error('Invitation not found')
      }

      await tx
        .insert(boardMembers)
        .values({
          boardId: invitation.boardId,
          userId,
          permission: invitation.permission,
        })
        .onConflictDoUpdate({
          target: [boardMembers.boardId, boardMembers.userId],
          set: {
            permission: invitation.permission,
            updatedAt: new Date(),
          },
        })

      await tx
        .update(boardInvitations)
        .set({
          status: INVITATION_STATUS_ACCEPTED,
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(boardInvitations.id, invitation.id))
      })
  }

  async function declinePendingInvitationByToken(token: string, userId: string) {
    const userRows = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    const userEmail = userRows[0]?.email
    if (!userEmail) {
      throw new Error('User not found')
    }

    const normalizedEmail = normalizeEmail(userEmail)

    return db.transaction(async (tx) => {
      const boardInvitationRows = await tx
        .select()
        .from(boardInvitations)
        .where(and(
          eq(boardInvitations.token, token),
          eq(boardInvitations.emailLower, normalizedEmail),
          eq(boardInvitations.status, INVITATION_STATUS_PENDING),
        ))
        .limit(1)

      const boardInvitation = boardInvitationRows[0]
      if (boardInvitation) {
        await tx
          .update(boardInvitations)
          .set({
            status: INVITATION_STATUS_REVOKED,
            respondedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(boardInvitations.id, boardInvitation.id))
        return
      }

      const workspaceInvitationRows = await tx
        .select()
        .from(workspaceInvitations)
        .where(and(
          eq(workspaceInvitations.token, token),
          eq(workspaceInvitations.emailLower, normalizedEmail),
          eq(workspaceInvitations.status, INVITATION_STATUS_PENDING),
        ))
        .limit(1)

      const workspaceInvitation = workspaceInvitationRows[0]
      if (!workspaceInvitation) {
        throw new Error('Invitation not found')
      }

      await tx
        .update(workspaceInvitations)
        .set({
          status: 'declined',
          respondedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workspaceInvitations.id, workspaceInvitation.id))
    })
  }

  async function revokeBoardInvitation(boardId: string, inviteId: string) {
    await db
      .update(boardInvitations)
      .set({
        status: INVITATION_STATUS_REVOKED,
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(boardInvitations.id, inviteId), eq(boardInvitations.boardId, boardId)))
  }

  async function getBoardInvitationIds(boardId: string) {
    const rows = await db
      .select({ id: boardInvitations.id })
      .from(boardInvitations)
      .where(eq(boardInvitations.boardId, boardId))

    return rows.map((row) => row.id)
  }

  async function expireInvitations(inviteIds: string[]) {
    if (inviteIds.length === 0) {
      return
    }

    await db
      .update(boardInvitations)
      .set({
        status: 'expired',
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        inArray(boardInvitations.id, inviteIds),
        ne(boardInvitations.status, 'accepted'),
      ))
  }

  async function renameBoard(boardId: string, name: string) {
    const [board] = await db
      .update(boards)
      .set({ name, updatedAt: new Date() })
      .where(eq(boards.id, boardId))
      .returning()

    return board ?? null
  }

  async function duplicateBoard(boardId: string) {
    return db.transaction(async (tx) => {
      const sourceRows = await tx.select().from(boards).where(eq(boards.id, boardId)).limit(1)
      const source = sourceRows[0]
      if (!source) {
        return null
      }

      const [copy] = await tx
        .insert(boards)
        .values({
          workspaceId: source.workspaceId,
          name: `${source.name} (Copy)`,
        })
        .returning()

      const sourceElements = await tx
        .select({
          id: elements.id,
          type: elements.type,
          data: elements.data,
        })
        .from(elements)
        .where(eq(elements.boardId, boardId))

      const now = new Date()
      const duplicatedElements = buildDuplicatedElements(sourceElements, copy.id, now)

      if (duplicatedElements.length > 0) {
        await tx.insert(elements).values(duplicatedElements)
      }

      return copy ?? null
    })
  }

  async function deleteBoard(boardId: string) {
    await db.delete(boards).where(eq(boards.id, boardId))
  }

  async function leaveBoard(boardId: string, userId: string) {
    await db
      .delete(boardMembers)
      .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
  }

  async function setBoardFavorite(boardId: string, userId: string, isFavorite: boolean) {
    const access = await checkBoardAccess(boardId, userId)
    if (!access.hasAccess) {
      return null
    }

    try {
      if (isFavorite) {
        await db
          .insert(boardFavorites)
          .values({ boardId, userId, createdAt: new Date() })
          .onConflictDoUpdate({
            target: [boardFavorites.boardId, boardFavorites.userId],
            set: {
              createdAt: new Date(),
            },
          })
      } else {
        await db
          .delete(boardFavorites)
          .where(and(eq(boardFavorites.boardId, boardId), eq(boardFavorites.userId, userId)))
      }
    } catch (error) {
      if (isMissingRelationError(error)) {
        return null
      }

      throw error
    }

    return getBoard(boardId, userId)
  }

  return {
    createBoard,
    getBoardsForWorkspace,
    getBoard,
    listAccessibleBoards,
    getBoardElements,
    checkBoardAccess,
    getBoardMembers,
    upsertBoardMember,
    updateBoardMemberPermission,
    deleteBoardMember,
    setBoardLinkShare,
    rotateBoardLinkShareToken,
    getShareByToken,
    createBoardInvitation,
    listPendingInvitesForUser,
    acceptBoardInvitationByToken,
    declinePendingInvitationByToken,
    revokeBoardInvitation,
    getBoardInvitationIds,
    expireInvitations,
    renameBoard,
    duplicateBoard,
    deleteBoard,
    leaveBoard,
    setBoardFavorite,
  }
}

export type BoardService = ReturnType<typeof createBoardService>
