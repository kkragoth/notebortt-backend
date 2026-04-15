import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { boardMembers, boards, workspaceMembers } from '../../db/schema.js'
import type { BoardPermission } from '../board.service.constants.js'
import { workspaceRoleToBoardPermission } from '../board.service.utils.js'
import type { createBoardCatalog } from './catalog.js'

type BoardCatalog = ReturnType<typeof createBoardCatalog>

export function createBoardAccess(db: Database, catalog: BoardCatalog) {
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

    return rows[0] ? workspaceRoleToBoardPermission(rows[0].role) : null
  }

  async function checkBoardAccess(boardId: string, userId: string | undefined, shareToken?: string) {
    const board = await catalog.getBoard(boardId)
    if (!board) {
      return { hasAccess: false, permission: null }
    }

    if (shareToken && board.linkShareEnabled && board.linkShareToken === shareToken) {
      return { hasAccess: true, permission: board.linkSharePermission as BoardPermission }
    }

    if (!userId) {
      return { hasAccess: false, permission: null }
    }

    const directPermission = await getBoardMemberPermission(boardId, userId)
    if (directPermission) {
      return { hasAccess: true, permission: directPermission }
    }

    const workspacePermission = await getWorkspaceBoardMembershipPermission(board.workspaceId, userId)
    return workspacePermission
      ? { hasAccess: true, permission: workspacePermission }
      : { hasAccess: false, permission: null }
  }

  async function getShareByToken(token: string) {
    const rows = await db
      .select({ boardId: boards.id, permission: boards.linkSharePermission })
      .from(boards)
      .where(and(eq(boards.linkShareToken, token), eq(boards.linkShareEnabled, true)))
      .limit(1)

    return rows[0] ?? null
  }

  return {
    checkBoardAccess,
    getShareByToken,
  }
}
