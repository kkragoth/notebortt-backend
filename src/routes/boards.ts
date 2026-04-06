import { Router } from 'express'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
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

  function toRecord<T extends { id: string }>(rows: T[]): Record<string, T> {
    return Object.fromEntries(rows.map((row) => [row.id, row]))
  }

  async function canAdminBoard(boardId: string, userId: string): Promise<boolean> {
    const board = await boardService.getBoard(boardId)
    if (!board) {
      return false
    }

    return workspaceService.isWorkspaceMember(board.workspaceId, userId)
  }

  const optionalAuth = (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = authService.verifyAccessToken(header.slice(7))
        req.userId = payload.sub
      } catch {
        // Token invalid — continue as unauthenticated
      }
    }
    next()
  }

  router.get('/workspaces/:wid/boards', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const wid = req.params['wid'] as string

    const isMember = await workspaceService.isWorkspaceMember(wid, userId)
    if (!isMember) {
      res.status(403).json({ error: 'Forbidden' })
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
    const { name } = req.body

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const isMember = await workspaceService.isWorkspaceMember(wid, userId)
    if (!isMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const board = await boardService.createBoard(wid, name)
    res.status(201).json(board)
  })

  router.get('/boards/:id', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined

    const { hasAccess } = await boardService.checkBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const board = await boardService.getBoard(id)
    if (!board) {
      res.status(404).json({ error: 'Board not found' })
      return
    }
    res.json(board)
  })

  router.get('/boards/:id/elements', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined

    const { hasAccess } = await boardService.checkBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await boardStateService.loadBoard(id)
    const elements = await boardStateService.getElements(id)
    const lastSequence = await boardStateService.peekSequence(id)
    res.json({ elements, lastSequence })
  })

  router.post('/boards/:id/mutations', optionalAuth, async (req, res) => {
    const boardId = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined
    const { mutations } = req.body

    if (!Array.isArray(mutations) || mutations.length === 0 || mutations.length > 100) {
      res.status(400).json({ error: 'mutations must be an array of 1-100 items' })
      return
    }

    const access = await boardService.checkBoardAccess(boardId, req.userId, shareToken)
    if (!access.hasAccess || access.permission !== 'edit') {
      res.status(403).json({ error: 'No edit access to this board' })
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
    const access = await boardService.checkBoardAccess(boardId, req.userId, shareToken)
    if (!access.hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
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
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''

    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const board = await boardService.renameBoard(boardId, name)
    if (!board) {
      res.status(404).json({ error: 'Board not found' })
      return
    }

    res.json(board)
  })

  router.post('/boards/:id/duplicate', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const duplicate = await boardService.duplicateBoard(boardId)
    if (!duplicate) {
      res.status(404).json({ error: 'Board not found' })
      return
    }

    res.status(201).json(duplicate)
  })

  router.delete('/boards/:id', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      res.status(403).json({ error: 'Forbidden' })
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
      res.status(400).json({ error: 'Workspace members cannot leave board access via this endpoint' })
      return
    }

    await boardService.leaveBoard(boardId, userId)
    res.sendStatus(204)
  })

  router.get('/boards/:id/active-users', optionalAuth, async (req, res) => {
    const userId = req.userId
    const id = req.params['id'] as string
    const shareToken = req.query['shareToken'] as string | undefined

    const { hasAccess } = await boardService.checkBoardAccess(id, userId, shareToken)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const count = await boardStateService.getClientCount(id)
    res.json({ count })
  })

  router.post('/boards/:id/shares', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string
    const { userId: shareUserId, permission } = req.body

    const isWorkspaceMember = await canAdminBoard(id, userId)
    if (!isWorkspaceMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const share = await boardService.createBoardShare(id, shareUserId, permission ?? 'view')
    res.status(201).json(share)
  })

  router.post('/boards/:id/invites', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string
    const { email, role } = req.body

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required' })
      return
    }

    const inviteRole = role === 'editor' ? 'editor' : 'viewer'
    const isWorkspaceMember = await canAdminBoard(id, userId)
    if (!isWorkspaceMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const invitation = await boardService.createBoardInvitation(id, userId, email, inviteRole)
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
      res.status(404).json({ error: error instanceof Error ? error.message : 'Invitation not found' })
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
      res.status(403).json({ error: 'Forbidden' })
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
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await boardService.revokeBoardLink(boardId, linkId)
    res.sendStatus(204)
  })

  router.get('/boards/:id/shares', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string

    const { hasAccess } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const shares = await boardService.getBoardShares(id)
    res.json({ shares: toRecord(shares) })
  })

  router.patch('/boards/:id/shares/:shareId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const boardId = req.params['id'] as string
    const shareId = req.params['shareId'] as string
    const permission = req.body?.permission === 'edit' ? 'edit' : req.body?.permission === 'view' ? 'view' : null
    if (!permission) {
      res.status(400).json({ error: 'permission must be view or edit' })
      return
    }

    const isWorkspaceMember = await canAdminBoard(boardId, userId)
    if (!isWorkspaceMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await boardService.updateBoardSharePermission(boardId, shareId, permission)
    res.sendStatus(204)
  })

  router.get('/shared/:token', async (req, res) => {
    const token = req.params['token'] as string
    const share = await boardService.getShareByToken(token)

    if (!share) {
      res.status(404).json({ error: 'Share link not found or expired' })
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
      res.status(403).json({ error: 'Forbidden' })
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
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await boardService.revokeBoardInvitation(boardId, inviteId)
    res.sendStatus(204)
  })

  return router
}
