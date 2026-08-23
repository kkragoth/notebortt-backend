import { and, eq, sql } from 'drizzle-orm';
import { normalizeEmail } from '../board.service.utils.js';
import type { Database } from '@/platform/db/client.js';
import type { BoardPermission } from '../board.service.constants.js';
import { boardInvitations, boards, users, workspaceInvitations, workspaces } from '@/platform/db/schema.js';

export function createPendingInviteReadModel(db: Database) {
    async function getUserEmail(userId: string) {
        const rows = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        const email = rows[0]?.email;
        if (!email) {
            throw new Error('User not found');
        }

        return email;
    }

    async function listPendingInvitesForUser(userId: string) {
        const normalizedEmail = normalizeEmail(await getUserEmail(userId));
        const boardRows = await db
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
            .where(and(eq(boardInvitations.emailLower, normalizedEmail), eq(boardInvitations.status, 'pending')));

        const workspaceRows = await db
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
            .where(and(eq(workspaceInvitations.emailLower, normalizedEmail), eq(workspaceInvitations.status, 'pending')));

        return [
            ...boardRows.map((invitation) => ({
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
            ...workspaceRows.map((invitation) => ({
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
        ];
    }

    return { listPendingInvitesForUser };
}
