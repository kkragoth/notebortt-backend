import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { boardFavorites, boardMembers, boards, elements, workspaceMembers } from '../../db/schema.js'
import {
  BOARD_PERMISSION_EDIT,
  BOARD_PERMISSION_VIEW,
  type BoardPermission,
} from '../board.service.constants.js'
import { workspaceRoleToBoardPermission } from '../board.service.utils.js'
import { isMissingRelationError } from './helpers.js'

export type AccessibleBoard = typeof boards.$inferSelect & {
  permission: BoardPermission
  accessSource: 'workspace' | 'board_member'
  isFavorite: boolean
  favoriteCreatedAt: Date | null
}

export function createBoardCatalog(db: Database) {
  async function getFavoriteBoardMap(userId: string) {
    try {
      const rows = await db
        .select({ boardId: boardFavorites.boardId, createdAt: boardFavorites.createdAt })
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

  async function getBoardFavoriteCreatedAt(boardId: string, userId: string) {
    const rows = await db
      .select({ createdAt: boardFavorites.createdAt })
      .from(boardFavorites)
      .where(and(eq(boardFavorites.boardId, boardId), eq(boardFavorites.userId, userId)))
      .limit(1)

    return rows[0]?.createdAt ?? null
  }

  async function getBoard(boardId: string, userId?: string) {
    const rows = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1)
    const board = rows[0] ?? null
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
        linkShareViewEnabled: boards.linkShareViewEnabled,
        linkShareViewToken: boards.linkShareViewToken,
        linkShareEditEnabled: boards.linkShareEditEnabled,
        linkShareEditToken: boards.linkShareEditToken,
        createdAt: boards.createdAt,
        updatedAt: boards.updatedAt,
        permission: workspaceMembers.role,
      })
      .from(boards)
      .innerJoin(workspaceMembers, and(eq(boards.workspaceId, workspaceMembers.workspaceId), eq(workspaceMembers.userId, userId)))

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
        linkShareViewEnabled: boards.linkShareViewEnabled,
        linkShareViewToken: boards.linkShareViewToken,
        linkShareEditEnabled: boards.linkShareEditEnabled,
        linkShareEditToken: boards.linkShareEditToken,
        createdAt: boards.createdAt,
        updatedAt: boards.updatedAt,
        permission: boardMembers.permission,
      })
      .from(boards)
      .innerJoin(boardMembers, and(eq(boards.id, boardMembers.boardId), eq(boardMembers.userId, userId)))

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

    return [...deduped.values()]
  }

  async function getBoardElements(boardId: string): Promise<Record<string, { id: string; type: string; data: unknown; updatedAt: Date | null }>> {
    const rows = await db
      .select({ id: elements.id, type: elements.type, data: elements.data, updatedAt: elements.updatedAt })
      .from(elements)
      .where(eq(elements.boardId, boardId))

    return Object.fromEntries(rows.map((row) => [row.id, row]))
  }

  return {
    getBoard,
    getBoardsForWorkspace,
    listAccessibleBoards,
    getBoardElements,
  }
}
