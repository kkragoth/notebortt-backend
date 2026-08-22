import { Router } from 'express';
import type {BoardRouteDeps} from '@/routes/boards/shared.js';
import { sendForbidden, sendNotFound, toRecord } from '@/lib/http.js';
import { parseWithSchema } from '@/lib/validation.js';
import { createBoardBodySchema } from '@/openapi/schemas.js';
import {
    boardIdParamsSchema,
    canCreateBoards,
    canDeleteBoards,
    getWorkspaceRoleForBoard,
    parseOrSendBadRequest,
    requireBoardAccess,
    workspaceIdParamsSchema
  
} from '@/routes/boards/shared.js';

export function createBoardManagementRoutes(deps: BoardRouteDeps) {
    const router = Router();

    router.get('/workspaces/:wid/boards', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(workspaceIdParamsSchema, req.params, res);
        if (!params) return;

        const isMember = await deps.workspaceService.isWorkspaceMember(params.wid, userId);
        if (!isMember) {
            sendForbidden(res);
            return;
        }

        const boardList = await deps.boardService.getBoardsForWorkspace(params.wid, userId);
        res.json({ boards: toRecord(boardList) });
    });

    router.get('/boards', async (req, res) => {
        const userId = req.userId!;
        const boardList = await deps.boardService.listAccessibleBoards(userId);
        res.json({ boards: toRecord(boardList) });
    });

    router.post('/workspaces/:wid/boards', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(workspaceIdParamsSchema, req.params, res);
        if (!params) return;
        const parsed = parseWithSchema(createBoardBodySchema, req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.error });
            return;
        }

        const role = await deps.workspaceService.getWorkspaceMemberRole(params.wid, userId);
        if (!canCreateBoards(role)) {
            sendForbidden(res);
            return;
        }

        const board = await deps.boardService.createBoard(params.wid, parsed.data.name);
        res.status(201).json(board);
    });

    router.patch('/boards/:id', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;
        const parsed = parseWithSchema(createBoardBodySchema, req.body);
        if (!parsed.success) {
            res.status(400).json({ error: parsed.error.error });
            return;
        }

        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canCreateBoards(role)) {
            sendForbidden(res);
            return;
        }

        const board = await deps.boardService.renameBoard(params.id, parsed.data.name);
        if (!board) {
            sendNotFound(res, 'Board not found');
            return;
        }
        res.json(board);
    });

    router.post('/boards/:id/duplicate', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;

        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canCreateBoards(role)) {
            sendForbidden(res);
            return;
        }

        const duplicate = await deps.boardService.duplicateBoard(params.id);
        if (!duplicate) {
            sendNotFound(res, 'Board not found');
            return;
        }
        res.status(201).json(duplicate);
    });

    router.delete('/boards/:id', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;
        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (!canDeleteBoards(role)) {
            sendForbidden(res);
            return;
        }

        await deps.boardService.deleteBoard(params.id);
        await deps.boardStateService.flushBoard(params.id);
        res.sendStatus(204);
    });

    router.put('/boards/:id/favorite', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;

        const access = await requireBoardAccess(deps, params.id, userId);
        if (!access.hasAccess) {
            sendForbidden(res);
            return;
        }

        const board = await deps.boardService.setBoardFavorite(params.id, userId, true);
        if (!board) {
            sendForbidden(res);
            return;
        }

        res.json(board);
    });

    router.delete('/boards/:id/favorite', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;

        const access = await requireBoardAccess(deps, params.id, userId);
        if (!access.hasAccess) {
            sendForbidden(res);
            return;
        }

        const board = await deps.boardService.setBoardFavorite(params.id, userId, false);
        if (!board) {
            sendForbidden(res);
            return;
        }

        res.json(board);
    });

    router.post('/boards/:id/leave', async (req, res) => {
        const userId = req.userId!;
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        if (!params) return;

        const role = await getWorkspaceRoleForBoard(deps, params.id, userId);
        if (role) {
            res.status(400).json({ error: 'Workspace members cannot leave board access via this endpoint' });
            return;
        }

        await deps.boardService.leaveBoard(params.id, userId);
        res.sendStatus(204);
    });

    return router;
}
