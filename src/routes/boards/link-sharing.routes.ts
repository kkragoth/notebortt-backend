import { Router } from 'express'
import { sendForbidden, sendNotFound } from '../../lib/http.js'
import { parseWithSchema } from '../../lib/validation.js'
import { setBoardLinkSharingBodySchema } from '../../openapi/schemas.js'
import {
  boardIdParamsSchema,
  canManageBoardAccess,
  getWorkspaceRoleForBoard,
  parseOrSendBadRequest,
  type BoardRouteDeps,
} from './shared.js'

export function createBoardLinkSharingRoutes(deps: BoardRouteDeps) {
  const router = Router()

  router.patch('/boards/:id/link-sharing', async (req, res) => {
    const userId = req.userId!
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    if (!params) return
    const parsed = parseWithSchema(setBoardLinkSharingBodySchema, req.body)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.error })
      return
    }

    const role = await getWorkspaceRoleForBoard(deps, params.id, userId)
    if (!canManageBoardAccess(role)) {
      sendForbidden(res)
      return
    }

    const permission = parsed.data.permission === 'edit' ? 'edit' : 'view'
    const linkShare = await deps.boardService.setBoardLinkShare(params.id, parsed.data.enabled, permission)
    if (!linkShare) {
      sendNotFound(res, 'Board not found')
      return
    }
    res.json(linkShare)
  })

  router.post('/boards/:id/link-sharing/rotate', async (req, res) => {
    const userId = req.userId!
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    if (!params) return
    const role = await getWorkspaceRoleForBoard(deps, params.id, userId)
    if (!canManageBoardAccess(role)) {
      sendForbidden(res)
      return
    }

    const linkShare = await deps.boardService.rotateBoardLinkShareToken(params.id)
    if (!linkShare) {
      sendNotFound(res, 'Board not found')
      return
    }
    res.json(linkShare)
  })

  return router
}
