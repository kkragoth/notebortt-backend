import { Router } from 'express'
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendBadRequest, sendForbidden, sendNotFound, toRecord } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import {
  createJournalNoteBodySchema,
  patchJournalNoteBodySchema,
  sendJournalNoteToCanvasBodySchema,
} from '../openapi/schemas.js'
import type { JournalService } from '../services/journal.service.js'
import type { WorkspaceItemService } from '../services/workspace-item.service.js'
import type { WorkspaceService } from '../services/workspace.service.js'

const journalIdParamsSchema = z.object({
  journalId: z.string().trim().uuid(),
})

const noteParamsSchema = z.object({
  journalId: z.string().trim().uuid(),
  noteId: z.string().trim().uuid(),
})

const listNotesQuerySchema = z.object({
  status: z.enum(['active', 'archived']).optional().default('active'),
  q: z.string().trim().optional(),
  tag: z.string().trim().optional(),
})

function canEditWorkspace(role: string | null) {
  return role === 'owner' || role === 'admin' || role === 'editor'
}

export function createJournalsRouter(
  workspaceService: WorkspaceService,
  workspaceItemService: WorkspaceItemService,
  journalService: JournalService,
  authMiddleware: RequestHandler,
) {
  const router = Router()

  router.get('/journals/:journalId/notes', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(journalIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const query = parseWithSchema(listNotesQuerySchema, req.query)
    if (!query.success) {
      sendBadRequest(res, query.error.error)
      return
    }

    const journalItem = await workspaceItemService.getWorkspaceItem(params.data.journalId)
    if (!journalItem || journalItem.itemType !== 'journal') {
      sendNotFound(res, 'Journal not found')
      return
    }

    const isMember = await workspaceService.isWorkspaceMember(journalItem.workspaceId, userId)
    if (!isMember) {
      sendForbidden(res)
      return
    }

    const notes = await journalService.listJournalNotes(params.data.journalId, query.data)
    res.json({ notes: toRecord(notes) })
  })

  router.post('/journals/:journalId/notes', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(journalIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const parsed = parseWithSchema(createJournalNoteBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const journalItem = await workspaceItemService.getWorkspaceItem(params.data.journalId)
    if (!journalItem || journalItem.itemType !== 'journal') {
      sendNotFound(res, 'Journal not found')
      return
    }

    const role = await workspaceService.getWorkspaceMemberRole(journalItem.workspaceId, userId)
    if (!canEditWorkspace(role)) {
      sendForbidden(res)
      return
    }

    const note = await journalService.createJournalNote(params.data.journalId, userId, parsed.data)
    res.status(201).json(note)
  })

  router.get('/journals/:journalId/notes/:noteId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(noteParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const journalItem = await workspaceItemService.getWorkspaceItem(params.data.journalId)
    if (!journalItem || journalItem.itemType !== 'journal') {
      sendNotFound(res, 'Journal not found')
      return
    }

    const isMember = await workspaceService.isWorkspaceMember(journalItem.workspaceId, userId)
    if (!isMember) {
      sendForbidden(res)
      return
    }

    const note = await journalService.getJournalNote(params.data.journalId, params.data.noteId)
    if (!note) {
      sendNotFound(res, 'Note not found')
      return
    }

    res.json(note)
  })

  router.patch('/journals/:journalId/notes/:noteId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(noteParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const parsed = parseWithSchema(patchJournalNoteBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const journalItem = await workspaceItemService.getWorkspaceItem(params.data.journalId)
    if (!journalItem || journalItem.itemType !== 'journal') {
      sendNotFound(res, 'Journal not found')
      return
    }

    const role = await workspaceService.getWorkspaceMemberRole(journalItem.workspaceId, userId)
    if (!canEditWorkspace(role)) {
      sendForbidden(res)
      return
    }

    const result = await journalService.updateJournalNote(params.data.journalId, params.data.noteId, parsed.data)
    if (result.kind === 'not_found') {
      sendNotFound(res, 'Note not found')
      return
    }

    if (result.kind === 'conflict') {
      res.status(409).json({
        error: 'The note has a newer server version',
        note: result.note,
      })
      return
    }

    res.json(result.note)
  })

  router.post('/journals/:journalId/notes/:noteId/send-to-canvas', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(noteParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const parsed = parseWithSchema(sendJournalNoteToCanvasBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const note = await journalService.getJournalNote(params.data.journalId, params.data.noteId)
    if (!note) {
      sendNotFound(res, 'Note not found')
      return
    }

    const validation = await journalService.ensureJournalAndCanvasTypes(params.data.journalId, parsed.data.canvasBoardId)
    if (!validation.ok) {
      sendBadRequest(res, 'Journal or canvas item is invalid')
      return
    }

    const [canEditJournal, canEditCanvas] = await Promise.all([
      workspaceService.getWorkspaceMemberRole(validation.journalWorkspaceId, userId),
      workspaceService.getWorkspaceMemberRole(validation.canvasWorkspaceId, userId),
    ])

    if (!canEditWorkspace(canEditJournal) || !canEditWorkspace(canEditCanvas)) {
      sendForbidden(res)
      return
    }

    const link = await journalService.createJournalCanvasLink({
      noteId: note.id,
      canvasBoardId: parsed.data.canvasBoardId,
      targetContainerId: parsed.data.targetContainerId,
      targetElementId: parsed.data.targetElementId,
      syncMode: parsed.data.mode,
    })

    res.status(201).json(link)
  })

  return router
}
