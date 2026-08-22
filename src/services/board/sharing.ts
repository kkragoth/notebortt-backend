import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client.js';
import type { BoardPermission } from '@/services/board.service.constants.js';
import type { createBoardQueries } from '@/services/board/queries.js';
import { boardFavorites, boards } from '@/db/schema.js';
import { generateLinkShareToken, isMissingRelationError } from '@/services/board/helpers.js';

type BoardQueries = ReturnType<typeof createBoardQueries>

export function createBoardSharing(db: Database, queries: BoardQueries) {
    async function setBoardLinkShare(boardId: string, permission: BoardPermission, enabled: boolean) {
        const patch = permission === 'view'
            ? {
                linkShareViewEnabled: enabled,
                linkShareViewToken: enabled ? generateLinkShareToken() : null,
            }
            : {
                linkShareEditEnabled: enabled,
                linkShareEditToken: enabled ? generateLinkShareToken() : null,
            };

        const [board] = await db
            .update(boards)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(boards.id, boardId))
            .returning({
                id: boards.id,
                linkShareViewEnabled: boards.linkShareViewEnabled,
                linkShareViewToken: boards.linkShareViewToken,
                linkShareEditEnabled: boards.linkShareEditEnabled,
                linkShareEditToken: boards.linkShareEditToken,
            });

        if (!board) {
            return null;
        }

        return {
            enabled: permission === 'view' ? board.linkShareViewEnabled : board.linkShareEditEnabled,
            permission,
            token: permission === 'view' ? board.linkShareViewToken : board.linkShareEditToken,
        };
    }

    async function rotateBoardLinkShareToken(boardId: string, permission: BoardPermission) {
        const patch = permission === 'view'
            ? { linkShareViewToken: generateLinkShareToken() }
            : { linkShareEditToken: generateLinkShareToken() };

        const [board] = await db
            .update(boards)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(boards.id, boardId))
            .returning({
                id: boards.id,
                linkShareViewEnabled: boards.linkShareViewEnabled,
                linkShareViewToken: boards.linkShareViewToken,
                linkShareEditEnabled: boards.linkShareEditEnabled,
                linkShareEditToken: boards.linkShareEditToken,
            });

        if (!board) {
            return null;
        }

        return {
            enabled: permission === 'view' ? board.linkShareViewEnabled : board.linkShareEditEnabled,
            permission,
            token: permission === 'view' ? board.linkShareViewToken : board.linkShareEditToken,
        };
    }

    async function setBoardFavorite(boardId: string, userId: string, isFavorite: boolean) {
        const access = await queries.checkBoardAccess(boardId, userId);
        if (!access.hasAccess) {
            return null;
        }

        try {
            if (isFavorite) {
                await db
                    .insert(boardFavorites)
                    .values({ boardId, userId, createdAt: new Date() })
                    .onConflictDoUpdate({
                        target: [boardFavorites.boardId, boardFavorites.userId],
                        set: { createdAt: new Date() },
                    });
            } else {
                await db
                    .delete(boardFavorites)
                    .where(and(eq(boardFavorites.boardId, boardId), eq(boardFavorites.userId, userId)));
            }
        } catch (error) {
            if (isMissingRelationError(error)) {
                return null;
            }
            throw error;
        }

        return queries.getBoard(boardId, userId);
    }

    return {
        setBoardLinkShare,
        rotateBoardLinkShareToken,
        setBoardFavorite,
    };
}