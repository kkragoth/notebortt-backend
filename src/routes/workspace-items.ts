import { Router } from 'express'
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendBadRequest, sendForbidden, sendNotFound, toRecord } from '../lib/http.js'
import { parseWithSchema } from '../lib/validation.js'
import {
  createWorkspaceItemBodySchema,
  patchWorkspaceItemBodySchema,
  reorderWorkspaceItemsBodySchema,
} from '../openapi/schemas.js'
import type { WorkspaceItemService } from '../services/workspace-item.service.js'
import type { WorkspaceService } from '../services/workspace.service.js'

const workspaceIdParamsSchema = z.object({
  wid: z.string().trim().uuid(),
})

const itemIdParamsSchema = z.object({
  itemId: z.string().trim().uuid(),
})

const listItemsQuerySchema = z.object({
  status: z.enum(['active', 'archived']).optional().default('active'),
})

function canWriteWorkspaceItems(role: string | null) {
  return role === 'owner' || role === 'admin' || role === 'editor'
}

export function createWorkspaceItemsRouter(
  workspaceService: WorkspaceService,
  workspaceItemService: WorkspaceItemService,
  authMiddleware: RequestHandler,
) {
  const router = Router()

  router.get('/workspaces/:wid/items', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(workspaceIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const query = parseWithSchema(listItemsQuerySchema, req.query)
    if (!query.success) {
      sendBadRequest(res, query.error.error)
      return
    }

    const isMember = await workspaceService.isWorkspaceMember(params.data.wid, userId)
    if (!isMember) {
      sendForbidden(res)
      return
    }

    const items = await workspaceItemService.listWorkspaceItems(params.data.wid, query.data.status)
    res.json({ items: toRecord(items) })
  })

  router.post('/workspaces/:wid/items', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(workspaceIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const parsed = parseWithSchema(createWorkspaceItemBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const role = await workspaceService.getWorkspaceMemberRole(params.data.wid, userId)
    if (!canWriteWorkspaceItems(role)) {
      sendForbidden(res)
      return
    }

    const item = await workspaceItemService.createWorkspaceItem(params.data.wid, {
      type: parsed.data.type,
      name: parsed.data.name,
      avatarShortcut: parsed.data.avatarShortcut,
      avatarColor: parsed.data.avatarColor,
    })
    res.status(201).json(item)
  })

  router.patch('/items/:itemId', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(itemIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const parsed = parseWithSchema(patchWorkspaceItemBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const existing = await workspaceItemService.getWorkspaceItem(params.data.itemId)
    if (!existing) {
      sendNotFound(res, 'Workspace item not found')
      return
    }

    const role = await workspaceService.getWorkspaceMemberRole(existing.workspaceId, userId)
    if (!canWriteWorkspaceItems(role)) {
      sendForbidden(res)
      return
    }

    const item = await workspaceItemService.updateWorkspaceItem(params.data.itemId, parsed.data)
    if (!item) {
      sendNotFound(res, 'Workspace item not found')
      return
    }

    res.json(item)
  })

  router.post('/workspaces/:wid/items/reorder', authMiddleware, async (req, res) => {
    const userId = req.userId!
    const params = parseWithSchema(workspaceIdParamsSchema, req.params)
    if (!params.success) {
      sendBadRequest(res, params.error.error)
      return
    }

    const parsed = parseWithSchema(reorderWorkspaceItemsBodySchema, req.body)
    if (!parsed.success) {
      sendBadRequest(res, parsed.error.error)
      return
    }

    const role = await workspaceService.getWorkspaceMemberRole(params.data.wid, userId)
    if (!canWriteWorkspaceItems(role)) {
      sendForbidden(res)
      return
    }

    const result = await workspaceItemService.reorderWorkspaceItems(
      params.data.wid,
      parsed.data.orderedItemIds,
      parsed.data.typeOrder,
    )

    if (!result.success) {
      sendBadRequest(res, 'orderedItemIds contain items outside this workspace')
      return
    }

    res.sendStatus(204)
  })

  return router
}
