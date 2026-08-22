import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '@/db/client.js';
import { users, workspaceInvitations, workspaceMembers, workspaces } from '@/db/schema.js';
import {
    INVITATION_STATUS_PENDING,
    WorkspaceInvitationError,
    buildInvitationExpiry,
    generateInvitationToken,
    isUniqueViolation,
    normalizeEmail,
    trimEmail,
} from '@/services/workspace/common.js';

export function createWorkspaceInvitations(db: Database) {
    async function getWorkspaceInvitations(workspaceId: string) {
        const rows = await db
            .select({
                id: workspaceInvitations.id,
                workspaceId: workspaceInvitations.workspaceId,
                invitedBy: workspaceInvitations.invitedBy,
                email: workspaceInvitations.email,
                emailLower: workspaceInvitations.emailLower,
                role: workspaceInvitations.role,
                status: workspaceInvitations.status,
                token: workspaceInvitations.token,
                expiresAt: workspaceInvitations.expiresAt,
                respondedAt: workspaceInvitations.respondedAt,
                createdAt: workspaceInvitations.createdAt,
                updatedAt: workspaceInvitations.updatedAt,
                invitedByName: users.name,
                invitedByEmail: users.email,
            })
            .from(workspaceInvitations)
            .innerJoin(users, eq(workspaceInvitations.invitedBy, users.id))
            .where(eq(workspaceInvitations.workspaceId, workspaceId));

        return rows;
    }

    async function createInvitation(workspaceId: string, email: string, role: string, invitedBy: string) {
        const emailRaw = trimEmail(email);
        const emailLower = normalizeEmail(email);

        const existingPending = await db
            .select({
                id: workspaceInvitations.id,
                workspaceId: workspaceInvitations.workspaceId,
                invitedBy: workspaceInvitations.invitedBy,
                email: workspaceInvitations.email,
                emailLower: workspaceInvitations.emailLower,
                role: workspaceInvitations.role,
                status: workspaceInvitations.status,
                token: workspaceInvitations.token,
                expiresAt: workspaceInvitations.expiresAt,
                respondedAt: workspaceInvitations.respondedAt,
                createdAt: workspaceInvitations.createdAt,
                updatedAt: workspaceInvitations.updatedAt,
            })
            .from(workspaceInvitations)
            .where(and(
                eq(workspaceInvitations.workspaceId, workspaceId),
                eq(workspaceInvitations.emailLower, emailLower),
                eq(workspaceInvitations.status, INVITATION_STATUS_PENDING),
            ))
            .limit(1);

        if (existingPending.length > 0) {
            return existingPending[0];
        }

        const token = generateInvitationToken();
        const expiresAt = buildInvitationExpiry();

        try {
            const [invitation] = await db
                .insert(workspaceInvitations)
                .values({
                    workspaceId,
                    email: emailRaw,
                    emailLower,
                    role,
                    invitedBy,
                    status: INVITATION_STATUS_PENDING,
                    token,
                    expiresAt,
                })
                .returning();

            return invitation;
        } catch (error) {
            if (isUniqueViolation(error)) {
                const [pendingInvitation] = await db
                    .select()
                    .from(workspaceInvitations)
                    .where(and(
                        eq(workspaceInvitations.workspaceId, workspaceId),
                        eq(workspaceInvitations.emailLower, emailLower),
                        eq(workspaceInvitations.status, INVITATION_STATUS_PENDING),
                    ))
                    .limit(1);

                if (pendingInvitation) {
                    return pendingInvitation;
                }
            }

            throw error;
        }
    }

    async function getInvitation(token: string) {
        const result = await db
            .select({
                id: workspaceInvitations.id,
                workspaceId: workspaceInvitations.workspaceId,
                workspaceName: workspaces.name,
                invitedBy: workspaceInvitations.invitedBy,
                email: workspaceInvitations.email,
                emailLower: workspaceInvitations.emailLower,
                role: workspaceInvitations.role,
                status: workspaceInvitations.status,
                token: workspaceInvitations.token,
                expiresAt: workspaceInvitations.expiresAt,
                respondedAt: workspaceInvitations.respondedAt,
                createdAt: workspaceInvitations.createdAt,
                updatedAt: workspaceInvitations.updatedAt,
                invitedByName: users.name,
                invitedByEmail: users.email,
            })
            .from(workspaceInvitations)
            .innerJoin(users, eq(workspaceInvitations.invitedBy, users.id))
            .innerJoin(workspaces, eq(workspaceInvitations.workspaceId, workspaces.id))
            .where(eq(workspaceInvitations.token, token))
            .limit(1);

        return result[0] ?? null;
    }

    async function acceptInvitation(token: string, userId: string) {
        const userRows = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        const currentUserEmail = userRows[0]?.email;
        if (!currentUserEmail) {
            throw new WorkspaceInvitationError('user_not_found', 'User not found');
        }

        return db.transaction(async (tx) => {
            const invitations = await tx
                .select()
                .from(workspaceInvitations)
                .where(eq(workspaceInvitations.token, token))
                .limit(1);

            const invitation = invitations[0];
            if (!invitation) {
                throw new WorkspaceInvitationError('not_found', 'Invitation not found');
            }

            if (invitation.emailLower !== normalizeEmail(currentUserEmail)) {
                throw new WorkspaceInvitationError('wrong_user', 'Invitation email does not match current user');
            }

            const now = new Date();
            const acceptedRows = await tx
                .update(workspaceInvitations)
                .set({ status: 'accepted', respondedAt: new Date(), updatedAt: new Date() })
                .where(and(
                    eq(workspaceInvitations.id, invitation.id),
                    eq(workspaceInvitations.status, 'pending'),
                    gt(workspaceInvitations.expiresAt, now),
                ))
                .returning({ id: workspaceInvitations.id, expiresAt: workspaceInvitations.expiresAt });

            if (acceptedRows.length === 0) {
                throw new WorkspaceInvitationError('expired_or_used', 'Invitation is expired or already used');
            }

            await tx.insert(workspaceMembers).values({
                workspaceId: invitation.workspaceId,
                userId,
                role: invitation.role,
                addedBy: invitation.invitedBy,
                updatedAt: new Date(),
            }).onConflictDoNothing();

            const workspaceRows = await tx
                .select()
                .from(workspaces)
                .where(eq(workspaces.id, invitation.workspaceId))
                .limit(1);

            return workspaceRows[0];
        });
    }

    return {
        getWorkspaceInvitations,
        createInvitation,
        getInvitation,
        acceptInvitation,
    };
}
