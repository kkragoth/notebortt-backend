import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { WorkspaceService } from '../services/workspace.service.js'

export function createWorkspaceRouter(workspaceService: WorkspaceService, authMiddleware: RequestHandler) {
  const router = Router()

  function toRecord<T extends { id: string }>(rows: T[]): Record<string, T> {
    return Object.fromEntries(rows.map((row) => [row.id, row]))
  }

  router.get('/workspaces', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const workspaces = await workspaceService.getWorkspacesForUser(userId)
    res.json({ workspaces: toRecord(workspaces) })
  })

  router.post('/workspaces', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const { name } = req.body

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const workspace = await workspaceService.createWorkspace(name, userId)
    res.status(201).json(workspace)
  })

  router.get('/workspaces/:wid/members', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const wid = req.params['wid'] as string

    const isMember = await workspaceService.isWorkspaceMember(wid, userId)
    if (!isMember) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const members = await workspaceService.getWorkspaceMembers(wid)
    res.json({ members: toRecord(members) })
  })

  router.post('/workspaces/:wid/invitations', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const wid = req.params['wid'] as string
    const { email, role } = req.body

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required' })
      return
    }

    const inviteRole = role ?? 'member'

    const memberRole = await workspaceService.getWorkspaceMemberRole(wid, userId)
    const isOwnerOrAdmin = memberRole === 'owner' || memberRole === 'admin'
    if (!isOwnerOrAdmin) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const invitation = await workspaceService.createInvitation(wid, email, inviteRole, userId)
    res.status(201).json(invitation)
  })

  router.get('/invitations/:token', async (req, res) => {
    const token = req.params['token'] as string
    const invitation = await workspaceService.getInvitation(token)

    if (!invitation) {
      res.status(404).json({ error: 'Invitation not found' })
      return
    }

    res.json(invitation)
  })

  router.post('/invitations/:token/accept', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const token = req.params['token'] as string

    try {
      const workspace = await workspaceService.acceptInvitation(token, userId)
      res.json(workspace)
    } catch {
      res.status(404).json({ error: 'Invitation not found or already used' })
    }
  })

  return router
}
