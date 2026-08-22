import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client.js';
import { boards, elements } from '@/db/schema.js';
import { buildDuplicatedElements } from '@/services/board.service.utils.js';

export function createBoardLifecycle(db: Database) {
    async function createBoard(workspaceId: string, name: string) {
        const [board] = await db.insert(boards).values({ workspaceId, name }).returning();
        return board;
    }

    async function renameBoard(boardId: string, name: string) {
        const [board] = await db
            .update(boards)
            .set({ name, updatedAt: new Date() })
            .where(eq(boards.id, boardId))
            .returning();

        return board ?? null;
    }

    async function duplicateBoard(boardId: string) {
        return db.transaction(async (tx) => {
            const sourceRows = await tx.select().from(boards).where(eq(boards.id, boardId)).limit(1);
            const source = sourceRows[0];
            if (!source) {
                return null;
            }

            const [copy] = await tx
                .insert(boards)
                .values({ workspaceId: source.workspaceId, name: `${source.name} (Copy)` })
                .returning();

            const sourceElements = await tx
                .select({ id: elements.id, type: elements.type, data: elements.data })
                .from(elements)
                .where(eq(elements.boardId, boardId));

            const duplicatedElements = buildDuplicatedElements(sourceElements, copy.id, new Date());
            if (duplicatedElements.length > 0) {
                await tx.insert(elements).values(duplicatedElements);
            }

            return copy ?? null;
        });
    }

    async function deleteBoard(boardId: string) {
        await db.delete(boards).where(eq(boards.id, boardId));
    }

    return {
        createBoard,
        renameBoard,
        duplicateBoard,
        deleteBoard,
    };
}
