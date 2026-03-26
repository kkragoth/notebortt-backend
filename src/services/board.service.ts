import { eq, or, and } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import type { Database } from '../db/client.js'
import { boards, boardShares, elements, workspaceMembers } from '../db/schema.js'

export function createBoardService(db: Database) {
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
        return { hasAccess: true, permission: 'edit' }
      }

      const shareRows = await db
        .select({ permission: boardShares.permission })
        .from(boardShares)
        .where(and(eq(boardShares.boardId, boardId), eq(boardShares.userId, userId)))
        .limit(1)

      if (shareRows.length > 0) {
        const permission = shareRows[0].permission as 'view' | 'edit'
        return { hasAccess: true, permission }
      }
    }

    if (shareToken) {
      const tokenRows = await db
        .select({ permission: boardShares.permission, boardId: boardShares.boardId })
        .from(boardShares)
        .where(and(eq(boardShares.token, shareToken), eq(boardShares.boardId, boardId)))
        .limit(1)

      if (tokenRows.length > 0) {
        const permission = tokenRows[0].permission as 'view' | 'edit'
        return { hasAccess: true, permission }
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

  async function getShareByToken(token: string) {
    const rows = await db
      .select({ boardId: boardShares.boardId, permission: boardShares.permission })
      .from(boardShares)
      .where(eq(boardShares.token, token))
      .limit(1)

    return rows[0] ?? null
  }

  async function getBoardShares(boardId: string) {
    return db.select().from(boardShares).where(eq(boardShares.boardId, boardId))
  }

  async function deleteBoardShare(shareId: string) {
    await db.delete(boardShares).where(eq(boardShares.id, shareId))
  }

  return {
    createBoard,
    getBoardsForWorkspace,
    getBoard,
    getBoardElements,
    checkBoardAccess,
    createBoardShare,
    getBoardShares,
    deleteBoardShare,
    getShareByToken,
  }
}

export type BoardService = ReturnType<typeof createBoardService>
