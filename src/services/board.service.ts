import { randomBytes, randomUUID } from 'crypto'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boards, boardInvitations, boardShares, elements, users, workspaceMembers } from '../db/schema.js'

const BOARD_PERMISSION_VIEW = 'view'
const BOARD_PERMISSION_EDIT = 'edit'
const BOARD_ROLE_EDITOR = 'editor'
const BOARD_ROLE_VIEWER = 'viewer'
const INVITATION_STATUS_PENDING = 'pending'
const INVITATION_STATUS_ACCEPTED = 'accepted'
const INVITATION_STATUS_REVOKED = 'revoked'

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function roleToPermission(role: string): 'view' | 'edit' {
  return role === BOARD_ROLE_EDITOR ? BOARD_PERMISSION_EDIT : BOARD_PERMISSION_VIEW
}

const REMAPPABLE_ID_KEYS = new Set([
  'id',
  'elementId',
  'parentId',
  'sourceId',
  'targetId',
  'startElementId',
  'endElementId',
  'containerId',
  'containedById',
  'columnId',
  'metaColumnId',
  'gridId',
  'noteId',
  'arrowId',
  'shapeId',
  'textId',
  'drawingId',
  'imageId',
  'linkPreviewId',
  'childId',
  'itemId',
])

function remapElementData(value: unknown, idMap: Map<string, string>, keyHint = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remapElementData(item, idMap, keyHint))
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = remapElementData(nestedValue, idMap, key)
    }
    return result
  }

  if (typeof value === 'string') {
    const remapped = idMap.get(value)
    if (!remapped) {
      return value
    }

    if (REMAPPABLE_ID_KEYS.has(keyHint) || keyHint.toLowerCase().includes('id')) {
      return remapped
    }
  }

  return value
}

export function createBoardService(db: Database) {
  type AccessibleBoard = typeof boards.$inferSelect & {
    permission: 'view' | 'edit'
    accessSource: 'workspace' | 'share'
  }

  async function createBoard(workspaceId: string, name: string) {
    const [board] = await db.insert(boards).values({ workspaceId, name }).returning()
    return board
  }

  async function getBoardsForWorkspace(workspaceId: string) {
    return db.select().from(boards).where(eq(boards.workspaceId, workspaceId))
  }

  async function getBoard(boardId: string) {
    const result = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1)
    return result[0] ?? null
  }

  async function listAccessibleBoards(userId: string): Promise<AccessibleBoard[]> {
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
        createdAt: boards.createdAt,
        updatedAt: boards.updatedAt,
        permission: workspaceMembers.role,
      })
      .from(boards)
      .innerJoin(workspaceMembers, and(
        eq(boards.workspaceId, workspaceMembers.workspaceId),
        eq(workspaceMembers.userId, userId),
      ))

    const directShares = await db
      .select({
        id: boards.id,
        workspaceId: boards.workspaceId,
        name: boards.name,
        currentCommitId: boards.currentCommitId,
        currentBranch: boards.currentBranch,
        previewSvg: boards.previewSvg,
        previewVersion: boards.previewVersion,
        previewUpdatedAt: boards.previewUpdatedAt,
        createdAt: boards.createdAt,
        updatedAt: boards.updatedAt,
        permission: boardShares.permission,
      })
      .from(boards)
      .innerJoin(boardShares, and(
        eq(boards.id, boardShares.boardId),
        eq(boardShares.userId, userId),
      ))

    const deduped = new Map<string, AccessibleBoard>()

    for (const board of workspaceBoards) {
      deduped.set(board.id, {
        ...board,
        permission: 'edit',
        accessSource: 'workspace',
      })
    }

    for (const board of directShares) {
      if (deduped.has(board.id)) {
        continue
      }

      deduped.set(board.id, {
        ...board,
        permission: board.permission === 'edit' ? 'edit' : 'view',
        accessSource: 'share',
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
  ): Promise<{ hasAccess: boolean; permission: 'view' | 'edit' | null }> {
    const board = await getBoard(boardId)
    if (!board) return { hasAccess: false, permission: null }

    if (userId) {
      const memberRows = await db
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, board.workspaceId), eq(workspaceMembers.userId, userId)))
        .limit(1)

      if (memberRows.length > 0) {
        return { hasAccess: true, permission: BOARD_PERMISSION_EDIT }
      }

      const shareRows = await db
        .select({ permission: boardShares.permission })
        .from(boardShares)
        .where(and(eq(boardShares.boardId, boardId), eq(boardShares.userId, userId)))
        .limit(1)

      if (shareRows.length > 0) {
        return { hasAccess: true, permission: shareRows[0].permission as 'view' | 'edit' }
      }
    }

    if (shareToken) {
      const tokenRows = await db
        .select({ permission: boardShares.permission, boardId: boardShares.boardId })
        .from(boardShares)
        .where(and(eq(boardShares.token, shareToken), eq(boardShares.boardId, boardId), isNull(boardShares.userId)))
        .limit(1)

      if (tokenRows.length > 0) {
        return { hasAccess: true, permission: tokenRows[0].permission as 'view' | 'edit' }
      }
    }

    return { hasAccess: false, permission: null }
  }

  async function createBoardShare(boardId: string, userId: string | undefined, permission: string) {
    const isPublicLink = !userId
    const token = isPublicLink ? randomBytes(24).toString('hex') : undefined

    const [share] = await db
      .insert(boardShares)
      .values({ boardId, userId: userId ?? null, permission, token })
      .returning()

    return share
  }

  async function createBoardLink(boardId: string, permission: 'view' | 'edit') {
    return createBoardShare(boardId, undefined, permission)
  }

  async function revokeBoardLink(boardId: string, shareId: string) {
    await db.delete(boardShares).where(and(eq(boardShares.id, shareId), eq(boardShares.boardId, boardId), isNull(boardShares.userId)))
  }

  async function getShareByToken(token: string) {
    const rows = await db
      .select({ boardId: boardShares.boardId, permission: boardShares.permission })
      .from(boardShares)
      .where(and(eq(boardShares.token, token), isNull(boardShares.userId)))
      .limit(1)

    return rows[0] ?? null
  }

  async function getBoardShares(boardId: string) {
    return db.select().from(boardShares).where(eq(boardShares.boardId, boardId))
  }

  async function deleteBoardShare(shareId: string) {
    await db.delete(boardShares).where(eq(boardShares.id, shareId))
  }

  async function updateBoardSharePermission(boardId: string, shareId: string, permission: 'view' | 'edit') {
    await db
      .update(boardShares)
      .set({ permission })
      .where(and(eq(boardShares.id, shareId), eq(boardShares.boardId, boardId)))
  }

  async function createBoardInvitation(boardId: string, invitedBy: string, email: string, role: 'editor' | 'viewer') {
    const normalizedEmail = normalizeEmail(email)

    const existingPending = await db
      .select({ id: boardInvitations.id })
      .from(boardInvitations)
      .where(and(
        eq(boardInvitations.boardId, boardId),
        eq(boardInvitations.emailLower, normalizedEmail),
        eq(boardInvitations.status, INVITATION_STATUS_PENDING),
      ))
      .limit(1)

    if (existingPending.length > 0) {
      return { inviteId: existingPending[0].id }
    }

    const [invitation] = await db
      .insert(boardInvitations)
      .values({
        boardId,
        invitedBy,
        emailLower: normalizedEmail,
        role,
        status: INVITATION_STATUS_PENDING,
      })
      .returning({ id: boardInvitations.id })

    return { inviteId: invitation.id }
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

    const invitations = await db
      .select({
        id: boardInvitations.id,
        boardId: boardInvitations.boardId,
        boardTitle: boards.name,
        role: boardInvitations.role,
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

    return invitations.map((invitation) => ({
      id: invitation.id,
      notificationId: null,
      boardId: invitation.boardId,
      boardTitle: invitation.boardTitle,
      role: invitation.role as 'editor' | 'viewer',
      createdAt: invitation.createdAt ? new Date(invitation.createdAt).getTime() : Date.now(),
      createdBy: invitation.createdBy,
      status: invitation.status as 'pending' | 'accepted' | 'revoked' | 'expired',
    }))
  }

  async function acceptBoardInvitation(boardId: string, inviteId: string, userId: string) {
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
          eq(boardInvitations.id, inviteId),
          eq(boardInvitations.boardId, boardId),
          eq(boardInvitations.emailLower, normalizeEmail(userEmail)),
          eq(boardInvitations.status, INVITATION_STATUS_PENDING),
        ))
        .limit(1)

      const invitation = invitationRows[0]
      if (!invitation) {
        throw new Error('Invitation not found')
      }

      const existingShareRows = await tx
        .select({ id: boardShares.id })
        .from(boardShares)
        .where(and(eq(boardShares.boardId, boardId), eq(boardShares.userId, userId)))
        .limit(1)

      if (existingShareRows.length === 0) {
        await tx.insert(boardShares).values({
          boardId,
          userId,
          permission: roleToPermission(invitation.role),
        })
      }

      await tx
        .update(boardInvitations)
        .set({ status: INVITATION_STATUS_ACCEPTED })
        .where(eq(boardInvitations.id, invitation.id))
    })
  }

  async function revokeBoardInvitation(boardId: string, inviteId: string) {
    await db
      .update(boardInvitations)
      .set({ status: INVITATION_STATUS_REVOKED })
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
      .set({ status: 'expired' })
      .where(inArray(boardInvitations.id, inviteIds))
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

      const idMap = new Map<string, string>()
      for (const element of sourceElements) {
        idMap.set(element.id, randomUUID())
      }

      const now = new Date()

      if (sourceElements.length > 0) {
        await tx
          .insert(elements)
          .values(sourceElements.map((element) => ({
            id: idMap.get(element.id)!,
            boardId: copy.id,
            type: element.type,
            data: remapElementData(element.data, idMap, '') as Record<string, unknown>,
            updatedAt: now,
          })))
      }

      return copy ?? null
    })
  }

  async function deleteBoard(boardId: string) {
    await db.delete(boards).where(eq(boards.id, boardId))
  }

  async function leaveBoard(boardId: string, userId: string) {
    await db
      .delete(boardShares)
      .where(and(eq(boardShares.boardId, boardId), eq(boardShares.userId, userId)))
  }

  return {
    createBoard,
    getBoardsForWorkspace,
    getBoard,
    listAccessibleBoards,
    getBoardElements,
    checkBoardAccess,
    createBoardShare,
    createBoardLink,
    revokeBoardLink,
    getBoardShares,
    deleteBoardShare,
    updateBoardSharePermission,
    getShareByToken,
    createBoardInvitation,
    listPendingInvitesForUser,
    acceptBoardInvitation,
    revokeBoardInvitation,
    getBoardInvitationIds,
    expireInvitations,
    renameBoard,
    duplicateBoard,
    deleteBoard,
    leaveBoard,
  }
}

export type BoardService = ReturnType<typeof createBoardService>
