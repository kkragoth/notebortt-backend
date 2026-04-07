import { Router } from 'express'
import type { RequestHandler } from 'express'
import { createOptionalAuth, getRequiredString, sendBadRequest, sendForbidden, sendNotFound, toRecord } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import { createBoardBodySchema, createBoardInviteBodySchema, updateBoardSharePermissionBodySchema } from '../openapi/schemas.js'
import type { BoardService } from '../services/board.service.js'
import type { WorkspaceService } from '../services/workspace.service.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'
import type { AuthService } from '../services/auth.service.js'
import type { PreviewJobService } from '../services/preview-job.service.js'

export function createBoardRouter(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  authMiddleware: RequestHandler,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
  authService: AuthService,
  previewJobService: PreviewJobService,
) {
  const router = Router()

  async function canAdminBoard(boardId: string, userId: string): Promise<boolean> {
    const board = await boardService.getBoard(boardId)
    if (!board) {
      return false
    }

    return workspaceService.isWorkspaceMember(board.workspaceId, userId)
  }

  const optionalAuth = createOptionalAuth(authService)

  async function requireBoardAccess(
    boardId: string,
    userId: string | undefined,
    shareToken?: string,
  ) {
    return boardService.checkBoardAccess(boardId, userId, shareToken)
  }

  router.get('/workspaces/:wid/boards', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const wid = req.params['wid'] as string

    const isMember = await workspaceService.isWorkspaceMember(wid, userId)
    if (!isMember) {
      sendForbidden(res)
      return
    }

    const boardList = await boardService.getBoardsForWorkspace(wid)
    res.json({ boards: toRecord(boardList) })
  })

  router.get('/boards', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardList = await boardService.listAccessibleBoards(userId)
    res.json({ boards: toRecord(boardList) })
  })

  router.post('/workspaces/:wid/boards', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const wid = req.params['wid'] as string
    const parsed = parseWithSchema(createBoardBodySchema, req.body)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const isMember = await workspaceService.isWorkspaceMember(wid, userId)
    if (!isMember) {
      sendForbidden(res)
      return
    }

    const board = await boardService.createBoard(wid, parsed.data.name)
    res.status(201).json(board)
  })

  router.get('/boards/:id', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined

    const { hasAccess } = await requireBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    const board = await boardService.getBoard(id)
    if (!board) {
      sendNotFound(res, 'Board not found')
      return
    }
    res.json(board)
  })

  router.get('/boards/:id/elements', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined

    const { hasAccess } = await requireBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    await boardStateService.loadBoard(id)
    const elements = await boardStateService.getElements(id)
    const lastSequence = await boardStateService.peekSequence(id)
    res.json({ elements, lastSequence })
  })

  router.patch('/boards/:id/elements', optionalAuth, async (req, res) => {
    const boardId = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined
    const { upserts, deletes } = req.body as {
      upserts?: unknown
      deletes?: unknown
    }

    if (!Array.isArray(upserts) || !Array.isArray(deletes) || (upserts.length === 0 && deletes.length === 0)) {
      sendBadRequest(res, 'upserts and deletes must be arrays and at least one change is required')
      return
    }

    const access = await requireBoardAccess(boardId, req.userId, shareToken)
    if (!access.hasAccess || access.permission !== 'edit') {
      sendForbidden(res, 'No edit access to this board')
      return
    }

    await boardStateService.loadBoard(boardId)
    const change = await boardStateService.applyChangeSet(boardId, {
      upserts: upserts as any[],
      deletes: deletes as string[],
    })

    void previewJobService.enqueue(boardId).catch((error) => {
      console.error('[PreviewJob] enqueue after element patch failed', error)
    })

    res.json({
      ok: true,
      sequence: change?.sequence ?? await boardStateService.peekSequence(boardId),
      serverTimestamp: change?.serverTimestamp ?? Date.now(),
    })
  })

  router.post('/boards/:id/mutations', optionalAuth, async (req, res) => {
    const boardId = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined
    const { mutations } = req.body

    if (!Array.isArray(mutations) || mutations.length === 0 || mutations.length > 100) {
      sendBadRequest(res, 'mutations must be an array of 1-100 items')
      return
    }

    const access = await requireBoardAccess(boardId, req.userId, shareToken)
    if (!access.hasAccess || access.permission !== 'edit') {
      sendForbidden(res, 'No edit access to this board')
      return
    }

    await boardStateService.loadBoard(boardId)
    const results = await mutationProcessor.processBatch(mutations, req.userId!)
    void previewJobService.enqueue(boardId).catch((error) => {
      console.error('[PreviewJob] enqueue after mutation failed', error)
    })

    res.json({ results })
  })

  router.post('/boards/:id/preview-jobs', optionalAuth, async (req, res) => {
    const boardId = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined
    const access = await requireBoardAccess(boardId, req.userId, shareToken)
    if (!access.hasAccess) {
      sendForbidden(res)
      return
    }

    const job = await previewJobService.enqueue(boardId)
    res.status(202).json({
      status: 'queued',
      boardId: job.boardId,
      dueAt: job.dueAt,
    })
  })

  router.patch('/boards/:id', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const parsed = parseWithSchema(createBoardBodySchema, req.body)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    const board = await boardService.renameBoard(boardId, parsed.data.name)
    if (!board) {
      sendNotFound(res, 'Board not found')
      return
    }

    res.json(board)
  })

  router.post('/boards/:id/duplicate', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    const duplicate = await boardService.duplicateBoard(boardId)
    if (!duplicate) {
      sendNotFound(res, 'Board not found')
      return
    }

    res.status(201).json(duplicate)
  })

  router.delete('/boards/:id', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    await boardService.deleteBoard(boardId)
    res.sendStatus(204)
  })

  router.post('/boards/:id/leave', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (isWorkspaceMember) {
      sendBadRequest(res, 'Workspace members cannot leave board access via this endpoint')
      return
    }

    await boardService.leaveBoard(boardId, userId)
    res.sendStatus(204)
  })

  router.get('/boards/:id/active-users', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined

    const { hasAccess } = await requireBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    const count = await boardStateService.getActiveViewerCount(id)
    res.json({ count })
  })

  router.post('/boards/:id/presence', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined
    const sessionId = getRequiredString(req.body?.sessionId)

    if (!sessionId) {
      sendBadRequest(res, 'sessionId is required')
      return
    }

    const { hasAccess } = await requireBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    await boardStateService.touchViewerSession(id, sessionId)
    res.sendStatus(204)
  })

  router.delete('/boards/:id/presence/:sessionId', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined
    const sessionId = req.params['sessionId'] as string

    if (!sessionId) {
      sendBadRequest(res, 'sessionId is required')
      return
    }

    const { hasAccess } = await requireBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    await boardStateService.removeViewerSession(id, sessionId)
    res.sendStatus(204)
  })

  router.post('/boards/:id/shares', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string
    const { userId: shareUserId, permission } = req.body

    const isWorkspaceMember = await canAdminBoard(id, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    const share = await boardService.createBoardShare(id, shareUserId, permission ?? 'view')
    res.status(201).json(share)
  })

  router.post('/boards/:id/invites', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string
    const parsed = parseWithSchema(createBoardInviteBodySchema, req.body)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const inviteRole = parsed.data.role === 'editor' ? 'editor' : 'viewer'
    const isWorkspaceMember = await canAdminBoard(id, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    const invitation = await boardService.createBoardInvitation(id, userId, parsed.data.email, inviteRole)
    res.status(201).json(invitation)
  })

  router.post('/boards/:id/invites/:inviteId/accept', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const inviteId = req.params['inviteId'] as string

    try {
      await boardService.acceptBoardInvitation(boardId, inviteId, userId)
      res.sendStatus(204)
    } catch (error) {
      sendNotFound(res, error instanceof Error ? error.message : 'Invitation not found')
    }
  })

  router.get('/sharing/pending-invites', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const invites = await boardService.listPendingInvitesForUser(userId)
    res.json({ invites })
  })

  router.post('/boards/:id/links', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    const link = await boardService.createBoardLink(boardId, 'view')
    res.status(201).json({ linkId: link.id, token: link.token })
  })

  router.delete('/boards/:id/links/:linkId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const linkId = req.params['linkId'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    await boardService.revokeBoardLink(boardId, linkId)
    res.sendStatus(204)
  })

  router.get('/boards/:id/shares', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string

    const { hasAccess } = await requireBoardAccess(id, userId)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    const shares = await boardService.getBoardShares(id)
    res.json({ shares: toRecord(shares) })
  })

  router.patch('/boards/:id/shares/:shareId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const shareId = req.params['shareId'] as string
    const parsed = parseWithSchema(updateBoardSharePermissionBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    await boardService.updateBoardSharePermission(boardId, shareId, parsed.data.permission)
    res.sendStatus(204)
  })

  router.get('/shared/:token', async (req, res) => {
    const token = req.params['token'] as string
    const share = await boardService.getShareByToken(token)

    if (!share) {
      sendNotFound(res, 'Share link not found or expired')
      return
    }

    res.json({ boardId: share.boardId, permission: share.permission })
  })

  router.delete('/boards/:id/shares/:shareId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string
    const shareId = req.params['shareId'] as string

    const isWorkspaceMember = await canAdminBoard(id, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    await boardService.deleteBoardShare(shareId)
    res.sendStatus(204)
  })

  router.delete('/boards/:id/invites/:inviteId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const inviteId = req.params['inviteId'] as string

    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      sendForbidden(res)
      return
    }

    await boardService.revokeBoardInvitation(boardId, inviteId)
    res.sendStatus(204)
  })

  return router
}
