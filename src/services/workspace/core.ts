import { and, eq } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import { users, workspaceMembers, workspaces } from '../../db/schema.js'

export interface WorkspaceVisualInput {
  avatarShortcut?: string | null
  gradientFrom?: string | null
  gradientTo?: string | null
  gradientPresetId?: string | null
  itemTypeOrder?: string[] | null
}

export function createWorkspaceCore(db: Database) {
  async function createWorkspace(name: string, ownerId: string, visuals: WorkspaceVisualInput = {}) {
    return db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values({
        name,
        ownerId,
        avatarShortcut: visuals.avatarShortcut ?? null,
        gradientFrom: visuals.gradientFrom ?? null,
        gradientTo: visuals.gradientTo ?? null,
        gradientPresetId: visuals.gradientPresetId ?? null,
        itemTypeOrder: visuals.itemTypeOrder ?? ['canvas', 'journal', 'graph'],
      }).returning()

      await tx.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: ownerId,
        role: 'owner',
        addedBy: null,
      })

      return workspace
    })
  }

  async function renameWorkspace(workspaceId: string, name: string) {
    const [workspace] = await db
      .update(workspaces)
      .set({ name, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning()

    return workspace ?? null
  }

  async function updateWorkspace(workspaceId: string, updates: {
    name?: string
    avatarShortcut?: string | null
    gradientFrom?: string | null
    gradientTo?: string | null
    gradientPresetId?: string | null
    itemTypeOrder?: string[]
  }) {
    const [workspace] = await db
      .update(workspaces)
      .set({
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.avatarShortcut !== undefined ? { avatarShortcut: updates.avatarShortcut } : {}),
        ...(updates.gradientFrom !== undefined ? { gradientFrom: updates.gradientFrom } : {}),
        ...(updates.gradientTo !== undefined ? { gradientTo: updates.gradientTo } : {}),
        ...(updates.gradientPresetId !== undefined ? { gradientPresetId: updates.gradientPresetId } : {}),
        ...(updates.itemTypeOrder !== undefined ? { itemTypeOrder: updates.itemTypeOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, workspaceId))
      .returning()

    return workspace ?? null
  }

  async function getWorkspacesForUser(userId: string) {
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        ownerId: workspaces.ownerId,
        role: workspaceMembers.role,
        avatarShortcut: workspaces.avatarShortcut,
        gradientFrom: workspaces.gradientFrom,
        gradientTo: workspaces.gradientTo,
        gradientPresetId: workspaces.gradientPresetId,
        itemTypeOrder: workspaces.itemTypeOrder,
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
        addedBy: workspaceMembers.addedBy,
        createdAt: workspaceMembers.createdAt,
        updatedAt: workspaceMembers.updatedAt,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(eq(workspaceMembers.workspaceId, workspaceId))

    return rows
  }

  async function deleteWorkspaceMember(workspaceId: string, memberId: string) {
    const memberRows = await db
      .select({
        id: workspaceMembers.id,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.id, memberId),
      ))
      .limit(1)

    const member = memberRows[0]
    if (!member) {
      return false
    }

    if (member.role === 'owner') {
      return false
    }

    await db
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, memberId))

    return true
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

  return {
    createWorkspace,
    renameWorkspace,
    updateWorkspace,
    getWorkspacesForUser,
    getWorkspaceMembers,
    deleteWorkspaceMember,
    isWorkspaceMember,
    getWorkspaceMemberRole,
  }
}
