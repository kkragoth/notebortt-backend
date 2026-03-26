import { Router } from 'express'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { BoardService } from '../services/board.service.js'
import type { WorkspaceService } from '../services/workspace.service.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'
import type { AuthService } from '../services/auth.service.js'

export function createBoardRouter(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  authMiddleware: RequestHandler,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
  authService: AuthService,
) {
  const router = Router()

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
    res.json(boardList)
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
    res.json({ elements, lastSequence: 0 })
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

    res.json({ results })
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

    const { hasAccess, permission: userPermission } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess || userPermission !== 'edit') {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const share = await boardService.createBoardShare(id, shareUserId, permission ?? 'view')
    res.status(201).json(share)
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
    res.json(shares)
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

    const { hasAccess, permission: userPermission } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess || userPermission !== 'edit') {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await boardService.deleteBoardShare(shareId)
    res.sendStatus(204)
  })

  return router
}
