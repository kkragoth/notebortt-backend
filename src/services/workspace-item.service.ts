import { and, asc, eq, inArray, max, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boards, workspaces } from '../db/schema.js'

export const WORKSPACE_ITEM_TYPES = ['canvas', 'journal', 'graph'] as const
export type WorkspaceItemType = (typeof WORKSPACE_ITEM_TYPES)[number]

export const WORKSPACE_ITEM_STATUSES = ['active', 'archived'] as const
export type WorkspaceItemStatus = (typeof WORKSPACE_ITEM_STATUSES)[number]

export interface CreateWorkspaceItemInput {
  type: WorkspaceItemType
  name: string
  avatarShortcut?: string
  avatarColor?: string
}

export interface UpdateWorkspaceItemInput {
  name?: string
  status?: WorkspaceItemStatus
  avatarShortcut?: string | null
  avatarColor?: string | null
  sidebarOrder?: number
}

const DEFAULT_ITEM_TYPE_ORDER: WorkspaceItemType[] = ['canvas', 'journal', 'graph']

function normalizeAvatarShortcut(value: string): string {
  return value.trim().toUpperCase().slice(0, 4)
}

function deriveAvatarShortcut(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return 'IT'
  }

  if (tokens.length === 1) {
    return normalizeAvatarShortcut(tokens[0]!.slice(0, 2))
  }

  return normalizeAvatarShortcut(`${tokens[0]![0] ?? ''}${tokens[1]![0] ?? ''}`)
}

function defaultAvatarColor(type: WorkspaceItemType): string {
  if (type === 'journal') {
    return 'violet'
  }

  if (type === 'graph') {
    return 'amber'
  }

  return 'blue'
}

function normalizeTypeOrder(input: unknown): WorkspaceItemType[] {
  if (!Array.isArray(input)) {
    return [...DEFAULT_ITEM_TYPE_ORDER]
  }

  const seen = new Set<WorkspaceItemType>()
  for (const value of input) {
    if (typeof value !== 'string') {
      continue
    }

    if (!WORKSPACE_ITEM_TYPES.includes(value as WorkspaceItemType)) {
      continue
    }

    seen.add(value as WorkspaceItemType)
  }

  for (const type of DEFAULT_ITEM_TYPE_ORDER) {
    seen.add(type)
  }

  return [...seen]
}

function sortByTypeOrder<T extends { itemType: string; sidebarOrder: number | null; name: string }>(
  items: T[],
  typeOrder: WorkspaceItemType[],
) {
  const rank = new Map(typeOrder.map((itemType, index) => [itemType, index]))
  return [...items].sort((left, right) => {
    const leftRank = rank.get(left.itemType as WorkspaceItemType) ?? Number.MAX_SAFE_INTEGER
    const rightRank = rank.get(right.itemType as WorkspaceItemType) ?? Number.MAX_SAFE_INTEGER
    if (leftRank !== rightRank) {
      return leftRank - rightRank
    }

    const leftOrder = left.sidebarOrder ?? 0
    const rightOrder = right.sidebarOrder ?? 0
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder
    }

    return left.name.localeCompare(right.name)
  })
}

export function createWorkspaceItemService(db: Database) {
  async function getWorkspaceTypeOrder(workspaceId: string): Promise<WorkspaceItemType[]> {
    const rows = await db
      .select({ itemTypeOrder: workspaces.itemTypeOrder })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    return normalizeTypeOrder(rows[0]?.itemTypeOrder)
  }

  async function listWorkspaceItems(workspaceId: string, status: WorkspaceItemStatus = 'active') {
    const [items, typeOrder] = await Promise.all([
      db
        .select()
        .from(boards)
        .where(and(eq(boards.workspaceId, workspaceId), eq(boards.status, status)))
        .orderBy(asc(boards.sidebarOrder), asc(boards.createdAt)),
      getWorkspaceTypeOrder(workspaceId),
    ])

    return sortByTypeOrder(items, typeOrder)
  }

  async function createWorkspaceItem(workspaceId: string, input: CreateWorkspaceItemInput) {
    const sidebarOrderRows = await db
      .select({ currentMax: max(boards.sidebarOrder) })
      .from(boards)
      .where(and(eq(boards.workspaceId, workspaceId), eq(boards.itemType, input.type)))

    const nextSidebarOrder = (sidebarOrderRows[0]?.currentMax ?? -1) + 1
    const [item] = await db
      .insert(boards)
      .values({
        workspaceId,
        name: input.name,
        itemType: input.type,
        status: 'active',
        avatarShortcut: normalizeAvatarShortcut(input.avatarShortcut ?? deriveAvatarShortcut(input.name)),
        avatarColor: input.avatarColor ?? defaultAvatarColor(input.type),
        sidebarOrder: nextSidebarOrder,
      })
      .returning()

    return item
  }

  async function getWorkspaceItem(itemId: string) {
    const rows = await db.select().from(boards).where(eq(boards.id, itemId)).limit(1)
    return rows[0] ?? null
  }

  async function updateWorkspaceItem(itemId: string, updates: UpdateWorkspaceItemInput) {
    const archivedAt = updates.status === 'archived'
      ? new Date()
      : updates.status === 'active'
        ? null
        : undefined

    const [item] = await db
      .update(boards)
      .set({
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.avatarShortcut !== undefined
          ? { avatarShortcut: updates.avatarShortcut ? normalizeAvatarShortcut(updates.avatarShortcut) : null }
          : {}),
        ...(updates.avatarColor !== undefined ? { avatarColor: updates.avatarColor } : {}),
        ...(updates.sidebarOrder !== undefined ? { sidebarOrder: updates.sidebarOrder } : {}),
        ...(archivedAt !== undefined ? { archivedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(boards.id, itemId))
      .returning()

    return item ?? null
  }

  async function reorderWorkspaceItems(workspaceId: string, orderedItemIds: string[], typeOrder?: WorkspaceItemType[]) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.workspaceId, workspaceId), inArray(boards.id, orderedItemIds)))

      if (rows.length !== orderedItemIds.length) {
        return { success: false as const, reason: 'invalid_workspace_item' as const }
      }

      for (let index = 0; index < orderedItemIds.length; index += 1) {
        const itemId = orderedItemIds[index]!
        await tx
          .update(boards)
          .set({ sidebarOrder: index, updatedAt: new Date() })
          .where(and(eq(boards.id, itemId), eq(boards.workspaceId, workspaceId)))
      }

      if (typeOrder && typeOrder.length > 0) {
        const normalizedTypeOrder = normalizeTypeOrder(typeOrder)
        await tx
          .update(workspaces)
          .set({
            itemTypeOrder: normalizedTypeOrder,
            updatedAt: new Date(),
          })
          .where(eq(workspaces.id, workspaceId))
      }

      return { success: true as const }
    })
  }

  async function countCanvasLinksByNoteIds(noteIds: string[]) {
    if (noteIds.length === 0) {
      return new Map<string, number>()
    }

    const rows = await db.execute(sql`
      SELECT note_id, COUNT(*)::int AS count
      FROM journal_note_canvas_links
      WHERE note_id = ANY(${noteIds})
      GROUP BY note_id
    `)

    const result = new Map<string, number>()
    for (const row of rows) {
      const noteId = String((row as { note_id?: unknown }).note_id ?? '')
      const count = Number((row as { count?: unknown }).count ?? 0)
      if (noteId) {
        result.set(noteId, Number.isFinite(count) ? count : 0)
      }
    }
    return result
  }

  return {
    countCanvasLinksByNoteIds,
    createWorkspaceItem,
    getWorkspaceItem,
    listWorkspaceItems,
    reorderWorkspaceItems,
    updateWorkspaceItem,
  }
}

export type WorkspaceItemService = ReturnType<typeof createWorkspaceItemService>
