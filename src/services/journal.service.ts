import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm'
import type { Database } from '../db/client.js'
import { boards, journalNoteCanvasLinks, journalNotes } from '../db/schema.js'

export const JOURNAL_NOTE_STATUSES = ['active', 'archived'] as const
export type JournalNoteStatus = (typeof JOURNAL_NOTE_STATUSES)[number]

export const JOURNAL_CANVAS_SYNC_MODES = ['synced', 'snapshot', 'plain_text'] as const
export type JournalCanvasSyncMode = (typeof JOURNAL_CANVAS_SYNC_MODES)[number]

export interface JournalNoteFilters {
  status: JournalNoteStatus
  q?: string
  tag?: string
}

export interface CreateJournalNoteInput {
  title?: string
  bodyJson?: unknown
  bodyText?: string
  excerpt?: string
  tags?: string[]
  color?: string | null
  colorTitle?: boolean
}

export interface UpdateJournalNoteInput {
  title?: string
  bodyJson?: unknown
  bodyText?: string
  excerpt?: string
  tags?: string[]
  color?: string | null
  colorTitle?: boolean
  pinned?: boolean
  status?: JournalNoteStatus
  updatedAt?: string
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return []
  }

  return [...new Set(
    tags
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 50),
  )]
}

export function createJournalService(db: Database) {
  async function listJournalNotes(journalId: string, filters: JournalNoteFilters) {
    const conditions = [eq(journalNotes.journalId, journalId), eq(journalNotes.status, filters.status)]

    if (filters.q && filters.q.trim()) {
      const term = `%${filters.q.trim()}%`
      conditions.push(
        sql`(${ilike(journalNotes.title, term)} OR ${ilike(journalNotes.excerpt, term)} OR ${ilike(journalNotes.bodyText, term)})`,
      )
    }

    if (filters.tag && filters.tag.trim()) {
      conditions.push(sql`${journalNotes.tags} @> ARRAY[${filters.tag.trim()}]::text[]`)
    }

    const notes = await db
      .select()
      .from(journalNotes)
      .where(and(...conditions))
      .orderBy(desc(journalNotes.pinned), desc(journalNotes.updatedAt))

    const noteIds = notes.map((note) => note.id)
    const linkedCountMap = await countLinkedCanvasByNoteIds(noteIds)

    return notes.map((note) => ({
      ...note,
      linkedCanvasCount: linkedCountMap.get(note.id) ?? 0,
    }))
  }

  async function createJournalNote(journalId: string, userId: string, input: CreateJournalNoteInput = {}) {
    const [note] = await db
      .insert(journalNotes)
      .values({
        journalId,
        title: input.title?.trim() || 'New note',
        bodyJson: input.bodyJson ?? {},
        bodyText: input.bodyText ?? '',
        excerpt: input.excerpt ?? '',
        tags: normalizeTags(input.tags),
        color: input.color ?? null,
        colorTitle: input.colorTitle ?? false,
        status: 'active',
        pinned: false,
        createdBy: userId,
      })
      .returning()

    return note
  }

  async function getJournalNote(journalId: string, noteId: string) {
    const rows = await db
      .select()
      .from(journalNotes)
      .where(and(eq(journalNotes.journalId, journalId), eq(journalNotes.id, noteId)))
      .limit(1)

    return rows[0] ?? null
  }

  async function updateJournalNote(journalId: string, noteId: string, updates: UpdateJournalNoteInput) {
    const existing = await getJournalNote(journalId, noteId)
    if (!existing) {
      return { kind: 'not_found' as const }
    }

    if (updates.updatedAt) {
      const clientUpdatedAt = new Date(updates.updatedAt).getTime()
      const serverUpdatedAt = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0
      if (Number.isFinite(clientUpdatedAt) && clientUpdatedAt < serverUpdatedAt) {
        return { kind: 'conflict' as const, note: existing }
      }
    }

    const archivedAt = updates.status === 'archived'
      ? new Date()
      : updates.status === 'active'
        ? null
        : undefined

    const [note] = await db
      .update(journalNotes)
      .set({
        ...(updates.title !== undefined ? { title: updates.title.trim() || existing.title } : {}),
        ...(updates.bodyJson !== undefined ? { bodyJson: updates.bodyJson } : {}),
        ...(updates.bodyText !== undefined ? { bodyText: updates.bodyText } : {}),
        ...(updates.excerpt !== undefined ? { excerpt: updates.excerpt } : {}),
        ...(updates.tags !== undefined ? { tags: normalizeTags(updates.tags) } : {}),
        ...(updates.color !== undefined ? { color: updates.color } : {}),
        ...(updates.colorTitle !== undefined ? { colorTitle: updates.colorTitle } : {}),
        ...(updates.pinned !== undefined ? { pinned: updates.pinned } : {}),
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(archivedAt !== undefined ? { archivedAt } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(journalNotes.id, noteId), eq(journalNotes.journalId, journalId)))
      .returning()

    if (!note) {
      return { kind: 'not_found' as const }
    }

    return { kind: 'ok' as const, note }
  }

  async function createJournalCanvasLink(input: {
    noteId: string
    canvasBoardId: string
    targetContainerId?: string
    targetElementId?: string
    syncMode: JournalCanvasSyncMode
  }) {
    const [link] = await db
      .insert(journalNoteCanvasLinks)
      .values({
        noteId: input.noteId,
        canvasBoardId: input.canvasBoardId,
        targetContainerId: input.targetContainerId ?? null,
        targetElementId: input.targetElementId ?? null,
        syncMode: input.syncMode,
      })
      .returning()

    return link
  }

  async function ensureJournalAndCanvasTypes(journalId: string, canvasBoardId: string) {
    const rows = await db
      .select({
        id: boards.id,
        workspaceId: boards.workspaceId,
        itemType: boards.itemType,
      })
      .from(boards)
      .where(inArray(boards.id, [journalId, canvasBoardId]))

    const journal = rows.find((row) => row.id === journalId)
    const canvas = rows.find((row) => row.id === canvasBoardId)

    if (!journal || !canvas) {
      return { ok: false as const, reason: 'not_found' as const }
    }

    if (journal.itemType !== 'journal' || canvas.itemType !== 'canvas') {
      return { ok: false as const, reason: 'invalid_item_type' as const }
    }

    return {
      ok: true as const,
      journalWorkspaceId: journal.workspaceId,
      canvasWorkspaceId: canvas.workspaceId,
    }
  }

  async function countLinkedCanvasByNoteIds(noteIds: string[]) {
    if (noteIds.length === 0) {
      return new Map<string, number>()
    }

    const rows = await db
      .select({
        noteId: journalNoteCanvasLinks.noteId,
        count: sql<number>`count(*)::int`,
      })
      .from(journalNoteCanvasLinks)
      .where(inArray(journalNoteCanvasLinks.noteId, noteIds))
      .groupBy(journalNoteCanvasLinks.noteId)

    return new Map(rows.map((row) => [row.noteId, Number(row.count ?? 0)] as const))
  }

  return {
    createJournalCanvasLink,
    createJournalNote,
    ensureJournalAndCanvasTypes,
    getJournalNote,
    listJournalNotes,
    updateJournalNote,
  }
}

export type JournalService = ReturnType<typeof createJournalService>
