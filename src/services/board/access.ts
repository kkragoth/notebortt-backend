import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client.js';
import type { BoardPermission } from '@/services/board.service.constants.js';
import type { createBoardCatalog } from '@/services/board/catalog.js';
import { boardMembers, boards, workspaceMembers } from '@/db/schema.js';
import {
    BOARD_PERMISSION_EDIT,
    BOARD_PERMISSION_VIEW,
} from '@/services/board.service.constants.js';
import { workspaceRoleToBoardPermission } from '@/services/board.service.utils.js';

type BoardCatalog = ReturnType<typeof createBoardCatalog>

export function createBoardAccess(db: Database, catalog: BoardCatalog) {
    async function getBoardMemberPermission(boardId: string, userId: string) {
        const rows = await db
            .select({ permission: boardMembers.permission })
            .from(boardMembers)
            .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
            .limit(1);

        return rows[0]?.permission as BoardPermission | undefined;
    }

    async function getWorkspaceBoardMembershipPermission(workspaceId: string, userId: string): Promise<BoardPermission | null> {
        const rows = await db
            .select({ role: workspaceMembers.role })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
            .limit(1);

        return rows[0] ? workspaceRoleToBoardPermission(rows[0].role) : null;
    }

    async function checkBoardAccess(boardId: string, userId: string | undefined, shareToken?: string) {
        const board = await catalog.getBoard(boardId);
        if (!board) {
            return { hasAccess: false, permission: null };
        }

        if (shareToken && board.linkShareViewEnabled && board.linkShareViewToken === shareToken) {
            return { hasAccess: true, permission: BOARD_PERMISSION_VIEW };
        }

        if (shareToken && board.linkShareEditEnabled && board.linkShareEditToken === shareToken) {
            return { hasAccess: true, permission: BOARD_PERMISSION_EDIT };
        }

        if (!userId) {
            return { hasAccess: false, permission: null };
        }

        const directPermission = await getBoardMemberPermission(boardId, userId);
        if (directPermission) {
            return { hasAccess: true, permission: directPermission };
        }

        const workspacePermission = await getWorkspaceBoardMembershipPermission(board.workspaceId, userId);
        return workspacePermission
            ? { hasAccess: true, permission: workspacePermission }
            : { hasAccess: false, permission: null };
    }

    async function getShareByToken(token: string) {
        const [viewMatch, editMatch] = await Promise.all([
            db
                .select({ boardId: boards.id })
                .from(boards)
                .where(and(eq(boards.linkShareViewToken, token), eq(boards.linkShareViewEnabled, true)))
                .limit(1),
            db
                .select({ boardId: boards.id })
                .from(boards)
                .where(and(eq(boards.linkShareEditToken, token), eq(boards.linkShareEditEnabled, true)))
                .limit(1),
        ]);

        if (viewMatch[0]) {
            return { boardId: viewMatch[0].boardId, permission: BOARD_PERMISSION_VIEW };
        }

        if (editMatch[0]) {
            return { boardId: editMatch[0].boardId, permission: BOARD_PERMISSION_EDIT };
        }

        return null;
    }

    return {
        checkBoardAccess,
        getShareByToken,
    };
}
