import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { BoardService } from '../services/board.service.js'
import type { WorkspaceService } from '../services/workspace.service.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'

export function createBoardRouter(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  authMiddleware: RequestHandler,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
) {
  const router = Router()

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

  router.get('/boards/:id', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string

    const { hasAccess } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const board = await boardService.getBoard(id)
    res.json(board)
  })

  router.get('/boards/:id/elements', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string

    const { hasAccess } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    await boardStateService.loadBoard(id)
    const elements = await boardStateService.getElements(id)
    res.json({ elements, lastSequence: 0 })
  })

  router.post('/boards/:id/mutations', authMiddleware, async (req, res) => {
    const boardId = req.params['id'] as string
    const { mutations } = req.body

    if (!Array.isArray(mutations) || mutations.length === 0 || mutations.length > 100) {
      res.status(400).json({ error: 'mutations must be an array of 1-100 items' })
      return
    }

    const access = await boardService.checkBoardAccess(boardId, req.userId!)
    if (!access.hasAccess || access.permission !== 'edit') {
      res.status(403).json({ error: 'No edit access to this board' })
      return
    }

    await boardStateService.loadBoard(boardId)
    const results = await mutationProcessor.processBatch(mutations, req.userId!)

    res.json({ results })
  })

  router.get('/boards/:id/active-users', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string

    const { hasAccess } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    res.json({ count: 0 })
  })

  router.post('/boards/:id/shares', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const id = req.params['id'] as string
    const { userId: shareUserId, permission, token } = req.body

    const { hasAccess, permission: userPermission } = await boardService.checkBoardAccess(id, userId)
    if (!hasAccess || userPermission !== 'edit') {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const share = await boardService.createBoardShare(id, shareUserId, permission ?? 'view', token)
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
