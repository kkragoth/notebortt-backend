import { eq, and } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import type { Database } from '../db/client.js'
import { workspaces, workspaceMembers, workspaceInvitations, users } from '../db/schema.js'

const INVITATION_TOKEN_BYTES = 32
const INVITATION_EXPIRES_DAYS = 7

function buildInvitationExpiry(): Date {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRES_DAYS)
  return expiresAt
}

function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString('hex')
}

export function createWorkspaceService(db: Database) {
  async function createWorkspace(name: string, ownerId: string) {
    return db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values({ name, ownerId }).returning()

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: ownerId,
        role: 'owner',
      })

      return workspace
    })
  }

  async function getWorkspacesForUser(userId: string) {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, userId))

    return rows
  }

  async function getWorkspaceMembers(workspaceId: string) {
    const rows = await db
      .select({
        id: workspaceMembers.id,
        workspaceId: workspaceMembers.workspaceId,
        userId: workspaceMembers.userId,
        role: workspaceMembers.role,
        createdAt: workspaceMembers.createdAt,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId))

    return rows
  }

  async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    const result = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1)

    return result.length > 0
  }

  async function getWorkspaceMemberRole(workspaceId: string, userId: string): Promise<string | null> {
    const result = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1)

    return result[0]?.role ?? null
  }

  async function createInvitation(workspaceId: string, email: string, role: string, invitedBy: string) {
    const token = generateInvitationToken()
    const expiresAt = buildInvitationExpiry()

    const [invitation] = await db
      .insert(workspaceInvitations)
      .values({ workspaceId, email, role, invitedBy, token, expiresAt })
      .returning()

    return invitation
  }

  async function getInvitation(token: string) {
    const result = await db
      .select()
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.token, token))
      .limit(1)

    return result[0] ?? null
  }

  async function acceptInvitation(token: string, userId: string) {
    return db.transaction(async (tx) => {
      const invitations = await tx
        .select()
        .from(workspaceInvitations)
        .where(eq(workspaceInvitations.token, token))
        .limit(1)

      const invitation = invitations[0]
      if (!invitation) throw new Error('Invitation not found')

      await tx
        .update(workspaceInvitations)
        .set({ status: 'accepted' })
        .where(eq(workspaceInvitations.id, invitation.id))

      await tx.insert(workspaceMembers).values({
        workspaceId: invitation.workspaceId,
        userId,
        role: invitation.role,
      })

      const workspaceRows = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, invitation.workspaceId))
        .limit(1)

      return workspaceRows[0]
    })
  }

  return {
    createWorkspace,
    getWorkspacesForUser,
    getWorkspaceMembers,
    isWorkspaceMember,
    getWorkspaceMemberRole,
    createInvitation,
    getInvitation,
    acceptInvitation,
  }
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>
