import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client.js';
import type { BoardPermission } from '@/services/board.service.constants.js';
import { boardMembers } from '@/db/schema.js';

export function createBoardMembers(db: Database) {
    async function getBoardMembers(boardId: string) {
        return db.select().from(boardMembers).where(eq(boardMembers.boardId, boardId));
    }

    async function upsertBoardMember(boardId: string, userId: string, permission: BoardPermission, addedBy?: string) {
        const [member] = await db
            .insert(boardMembers)
            .values({ boardId, userId, permission, addedBy: addedBy ?? null })
            .onConflictDoUpdate({
                target: [boardMembers.boardId, boardMembers.userId],
                set: { permission, addedBy: addedBy ?? null, updatedAt: new Date() },
            })
            .returning();

        return member;
    }

    async function updateBoardMemberPermission(boardId: string, memberId: string, permission: BoardPermission) {
        await db
            .update(boardMembers)
            .set({ permission, updatedAt: new Date() })
            .where(and(eq(boardMembers.id, memberId), eq(boardMembers.boardId, boardId)));
    }

    async function deleteBoardMember(boardId: string, memberId: string) {
        await db.delete(boardMembers).where(and(eq(boardMembers.id, memberId), eq(boardMembers.boardId, boardId)));
    }

    async function leaveBoard(boardId: string, userId: string) {
        await db.delete(boardMembers).where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)));
    }

    return {
        getBoardMembers,
        upsertBoardMember,
        updateBoardMemberPermission,
        deleteBoardMember,
        leaveBoard,
    };
}
