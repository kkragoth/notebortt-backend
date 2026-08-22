import { Router } from 'express';
import type {BoardRouteDeps} from '@/routes/boards/shared.js';
import { sendForbidden, toRecord } from '@/lib/http.js';
import { parseWithSchema } from '@/lib/validation.js';
import { updateBoardMemberPermissionBodySchema } from '@/openapi/schemas.js';
import {
    boardIdParamsSchema,
    boardMemberParamsSchema,
    canManageBoardAccess,
    getWorkspaceRoleForBoard,
    parseOrSendBadRequest,
    upsertBoardMemberBodySchema
  
} from '@/routes/boards/shared.js';

export function createBoardMemberRoutes(deps: BoardRouteDeps) {
    const router = Router();

    router.get('/boards/:id/members', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;
        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canManageBoardAccess(role)) {
            sendForbidden(res);
            return;
        }
        const members = await deps.boardService.getBoardMembers(params.id);
        res.json({ members: toRecord(members) });
    });

    router.post('/boards/:id/members', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        const body = parseOrSendBadRequest(upsertBoardMemberBodySchema, req.body, res);
        if (!params || !body) return;
        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canManageBoardAccess(role)) {
            sendForbidden(res);
            return;
        }

        const permission = body.permission === 'edit' ? 'edit' : 'view';
        const member = await deps.boardService.upsertBoardMember(params.id, body.userId, permission, userId);
        res.status(201).json(member);
    });

    router.patch('/boards/:id/members/:memberId', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardMemberParamsSchema, req.params, res);
        if (!params) return;
        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canManageBoardAccess(role)) {
            sendForbidden(res);
            return;
        }

        const parsed = parseWithSchema(updateBoardMemberPermissionBodySchema, req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.error });
            return;
        }
        await deps.boardService.updateBoardMemberPermission(params.id, params.memberId, parsed.data.permission);
        res.sendStatus(204);
    });

    router.delete('/boards/:id/members/:memberId', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardMemberParamsSchema, req.params, res);
        if (!params) return;
        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canManageBoardAccess(role)) {
            sendForbidden(res);
            return;
        }

        await deps.boardService.deleteBoardMember(params.id, params.memberId);
        res.sendStatus(204);
    });

    return router;
}
