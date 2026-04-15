import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { boardFavorites, boards } from '../../db/schema.js'
import type { BoardPermission } from '../board.service.constants.js'
import type { createBoardQueries } from './queries.js'
import { generateLinkShareToken, isMissingRelationError } from './helpers.js'

type BoardQueries = ReturnType<typeof createBoardQueries>

export function createBoardSharing(db: Database, queries: BoardQueries) {
  async function setBoardLinkShare(boardId: string, enabled: boolean, permission: BoardPermission) {
    const [board] = await db
      .update(boards)
      .set({
        linkShareEnabled: enabled,
        linkSharePermission: permission,
        linkShareToken: enabled ? generateLinkShareToken() : null,
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
      .set({ linkShareToken: generateLinkShareToken(), updatedAt: new Date() })
      .where(eq(boards.id, boardId))
      .returning({
        id: boards.id,
        linkShareEnabled: boards.linkShareEnabled,
        linkSharePermission: boards.linkSharePermission,
        linkShareToken: boards.linkShareToken,
      })

    return board ?? null
  }

  async function setBoardFavorite(boardId: string, userId: string, isFavorite: boolean) {
    const access = await queries.checkBoardAccess(boardId, userId)
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
            set: { createdAt: new Date() },
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

    return queries.getBoard(boardId, userId)
  }

  return {
    setBoardLinkShare,
    rotateBoardLinkShareToken,
    setBoardFavorite,
  }
}
