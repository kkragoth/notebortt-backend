import { Router } from 'express'
import { sendForbidden, sendNotFound } from '../../lib/http.js'
import {
  boardAccessQuerySchema,
  boardIdParamsSchema,
  inviteTokenParamsSchema,
  parseOrSendBadRequest,
  presenceBodySchema,
  presenceParamsSchema,
  requireBoardAccess,
  type BoardRouteDeps,
} from './shared.js'

export function createBoardAccessRoutes(deps: BoardRouteDeps) {
  const router = Router()

  router.get('/boards/:id', async (req, res) => {
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res)
    if (!params || !query) return

    const access = await requireBoardAccess(deps, params.id, req.userId, query.shareToken)
    if (!access.hasAccess) {
      sendForbidden(res)
      return
    }

    const board = await deps.boardService.getBoard(params.id, req.userId)
    if (!board) {
      sendNotFound(res, 'Board not found')
      return
    }
    res.json({ ...board, permission: access.permission })
  })

  router.get('/boards/:id/elements', async (req, res) => {
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res)
    if (!params || !query) return

    const { hasAccess } = await requireBoardAccess(deps, params.id, req.userId, query.shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    await deps.boardStateService.loadBoard(params.id)
    const elements = await deps.boardStateService.getElements(params.id)
    const lastSequence = await deps.boardStateService.peekSequence(params.id)
    res.json({ elements, lastSequence })
  })

  router.post('/boards/:id/preview-jobs', async (req, res) => {
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res)
    if (!params || !query) return

    const access = await requireBoardAccess(deps, params.id, req.userId, query.shareToken)
    if (!access.hasAccess) {
      sendForbidden(res)
      return
    }

    const job = await deps.previewJobService.enqueue(params.id)
    res.status(202).json({ status: 'queued', boardId: job.boardId, dueAt: job.dueAt })
  })

  router.get('/boards/:id/active-users', async (req, res) => {
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res)
    if (!params || !query) return

    const { hasAccess } = await requireBoardAccess(deps, params.id, req.userId, query.shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }
    const count = await deps.boardStateService.getActiveViewerCount(params.id)
    res.json({ count })
  })

  router.post('/boards/:id/presence', async (req, res) => {
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res)
    const body = parseOrSendBadRequest(presenceBodySchema, req.body, res)
    if (!params || !query || !body) return

    const { hasAccess } = await requireBoardAccess(deps, params.id, req.userId, query.shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    await deps.boardStateService.touchViewerSession(params.id, body.sessionId)
    res.sendStatus(204)
  })

  router.delete('/boards/:id/presence/:sessionId', async (req, res) => {
    const params = parseOrSendBadRequest(presenceParamsSchema, req.params, res)
    const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res)
    if (!params || !query) return

    const { hasAccess } = await requireBoardAccess(deps, params.id, req.userId, query.shareToken)
    if (!hasAccess) {
      sendForbidden(res)
      return
    }

    await deps.boardStateService.removeViewerSession(params.id, params.sessionId)
    res.sendStatus(204)
  })

  router.get('/shared/:token', async (req, res) => {
    const params = parseOrSendBadRequest(inviteTokenParamsSchema, req.params, res)
    if (!params) return
    const share = await deps.boardService.getShareByToken(params.token)
    if (!share) {
      sendNotFound(res, 'Share link not found or expired')
      return
    }
    res.json({ boardId: share.boardId, permission: share.permission })
  })

  return router
}
