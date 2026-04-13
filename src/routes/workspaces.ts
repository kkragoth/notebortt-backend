import { Router } from 'express'
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendBadRequest, sendForbidden, sendNotFound, toRecord } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import { createWorkspaceBodySchema, createWorkspaceInvitationBodySchema } from '../openapi/schemas.js'
import { WorkspaceInvitationError, type WorkspaceService } from '../services/workspace.service.js'

const workspaceIdParamsSchema = z.object({
  wid: z.string().trim().min(1),
})

const invitationTokenParamsSchema = z.object({
  token: z.string().trim().min(1),
})

export function createWorkspaceRouter(workspaceService: WorkspaceService, authMiddleware: RequestHandler) {
  const router = Router()

  router.get('/workspaces', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const workspaces = await workspaceService.getWorkspacesForUser(userId)
    res.json({ workspaces: toRecord(workspaces) })
  })

  router.post('/workspaces', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const parsed = parseWithSchema(createWorkspaceBodySchema, req.body)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const workspace = await workspaceService.createWorkspace(parsed.data.name, userId)
    res.status(201).json(workspace)
  })

  router.get('/workspaces/:wid/members', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(workspaceIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }
    const wid = params.data.wid

    const isMember = await workspaceService.isWorkspaceMember(wid, userId)
    if (!isMember) {
      sendForbidden(res)
      return
    }

    const members = await workspaceService.getWorkspaceMembers(wid)
    res.json({ members: toRecord(members) })
  })

  router.post('/workspaces/:wid/invitations', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(workspaceIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }
    const wid = params.data.wid
    const parsed = parseWithSchema(createWorkspaceInvitationBodySchema, req.body)

    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const inviteRole = parsed.data.role ?? 'viewer'

    const memberRole = await workspaceService.getWorkspaceMemberRole(wid, userId)
    const isOwnerOrAdmin = memberRole === 'owner' || memberRole === 'admin'
    if (!isOwnerOrAdmin) {
      sendForbidden(res)
      return
    }

    const invitation = await workspaceService.createInvitation(wid, parsed.data.email, inviteRole, userId)
    res.status(201).json(invitation)
  })

  router.get('/invitations/:token', async (req, res) => {
    const params = parseWithSchema(invitationTokenParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }
    const token = params.data.token
    const invitation = await workspaceService.getInvitation(token)

    if (!invitation) {
      sendNotFound(res, 'Invitation not found')
      return
    }

    res.json(invitation)
  })

  router.post('/invitations/:token/accept', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(invitationTokenParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }
    const token = params.data.token

    try {
      const workspace = await workspaceService.acceptInvitation(token, userId)
      res.json(workspace)
    } catch (error) {
      if (error instanceof WorkspaceInvitationError) {
        if (error.code === 'wrong_user') {
          sendForbidden(res, 'Invitation is for a different email address')
          return
        }

        if (error.code === 'not_found') {
          sendNotFound(res, 'Invitation not found')
          return
        }

        if (error.code === 'expired_or_used') {
          res.status(410).json({ error: 'Invitation expired or already used' })
          return
        }
      }

      sendNotFound(res, 'Invitation not found or already used')
    }
  })

  return router
}
