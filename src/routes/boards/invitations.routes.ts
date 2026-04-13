import { Router } from 'express'
import { sendForbidden, sendNotFound } from '../../lib/http.js'
import { parseWithSchema } from '../../lib/validation.js'
import { createBoardInviteBodySchema } from '../../openapi/schemas.js'
import {
  boardIdParamsSchema,
  boardInviteParamsSchema,
  canManageBoardAccess,
  getWorkspaceRoleForBoard,
  inviteTokenParamsSchema,
  parseOrSendBadRequest,
  type BoardRouteDeps,
} from './shared.js'

export function createBoardInvitationRoutes(deps: BoardRouteDeps) {
  const router = Router()

  router.post('/boards/:id/invites', async (req, res) => {
    const userId = req.userId!
    const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res)
    if (!params) return
    const parsed = parseWithSchema(createBoardInviteBodySchema, req.body)
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
    const invitation = await deps.boardService.createBoardInvitation(params.id, userId, parsed.data.email, permission)
    res.status(201).json(invitation)
  })

  router.post('/boards/invites/:token/accept', async (req, res) => {
    const userId = req.userId!
    const params = parseOrSendBadRequest(inviteTokenParamsSchema, req.params, res)
    if (!params) return

    try {
      await deps.boardService.acceptBoardInvitationByToken(params.token, userId)
      res.sendStatus(204)
    } catch (error) {
      sendNotFound(res, error instanceof Error ? error.message : 'Invitation not found')
    }
  })

  router.get('/sharing/pending-invites', async (req, res) => {
    const userId = req.userId!
    const invites = await deps.boardService.listPendingInvitesForUser(userId)
    res.json({ invites })
  })

  router.delete('/boards/:id/invites/:inviteId', async (req, res) => {
    const userId = req.userId!
    const params = parseOrSendBadRequest(boardInviteParamsSchema, req.params, res)
    if (!params) return

    const role = await getWorkspaceRoleForBoard(deps, params.id, userId)
    if (!canManageBoardAccess(role)) {
      sendForbidden(res)
      return
    }

    await deps.boardService.revokeBoardInvitation(params.id, params.inviteId)
    res.sendStatus(204)
  })

  return router
}
