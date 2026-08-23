import { Router } from 'express';
import {
    boardIdParamsSchema,
    canManageBoardAccess,
    getWorkspaceRoleForBoard,
    parseOrSendBadRequest
  
} from '../routes/shared.js';
import type {BoardRouteDeps} from '../routes/shared.js';
import { sendForbidden, sendNotFound } from '@/shared/http.js';
import { parseWithSchema } from '@/shared/validation.js';
import {
    rotateBoardLinkSharingBodySchema,
    setBoardLinkSharingBodySchema,
} from '@/shared/openapi/schemas.js';

export function createBoardLinkSharingRoutes(deps: BoardRouteDeps) {
    const router = Router();

    router.patch('/boards/:id/link-sharing', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;
        const parsed = parseWithSchema(setBoardLinkSharingBodySchema, req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.error });
            return;
        }

        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canManageBoardAccess(role)) {
            sendForbidden(res);
            return;
        }

        const permission = parsed.data.permission === 'edit' ? 'edit' : 'view';
        const linkShare = await deps.boardService.setBoardLinkShare(params.id, permission, parsed.data.enabled);
        if (!linkShare) {
            sendNotFound(res, 'Board not found');
            return;
        }
        res.json(linkShare);
    });

    router.post('/boards/:id/link-sharing/rotate', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;
        const parsed = parseWithSchema(rotateBoardLinkSharingBodySchema, req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.error });
            return;
        }

        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canManageBoardAccess(role)) {
            sendForbidden(res);
            return;
        }

        const linkShare = await deps.boardService.rotateBoardLinkShareToken(params.id, parsed.data.permission);
        if (!linkShare) {
            sendNotFound(res, 'Board not found');
            return;
        }
        res.json(linkShare);
    });

    return router;
}