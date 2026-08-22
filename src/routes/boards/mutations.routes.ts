import { Router } from 'express';
import type {BoardRouteDeps} from '@/routes/boards/shared.js';
import { logger } from '@/lib/logger.js';
import { sendForbidden } from '@/lib/http.js';
import { buildElementMutationBatch } from '@/routes/boards.utils.js';
import {
    anonymousActorId,
    boardAccessQuerySchema,
    boardIdParamsSchema,
    mutationsBodySchema,
    parseOrSendBadRequest,
    patchElementsBodySchema,
    requireBoardAccess
  
} from '@/routes/boards/shared.js';

export function createBoardMutationRoutes(deps: BoardRouteDeps) {
    const router = Router();

    router.patch('/boards/:id/elements', async (req, res) => {
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res);
        const body = parseOrSendBadRequest(patchElementsBodySchema, req.body, res);
        if (!params || !query || !body) return;

        const access = await requireBoardAccess(deps, params.id, req.userId, query.shareToken);
        if (!access.hasAccess || access.permission !== 'edit') {
            sendForbidden(res, 'No edit access to this board');
            return;
        }

        await deps.boardStateService.loadBoard(params.id);
        const currentElements = await deps.boardStateService.getElements(params.id);
        const mutations = buildElementMutationBatch(params.id, currentElements, body.upserts, body.deletes);
        const results = await deps.mutationProcessor.processBatch(mutations, anonymousActorId(req, body.sessionId));
        const latest = [...results].reverse().find((result) => result.status === 'applied') ?? results.at(-1);

        void deps.previewJobService.enqueue(params.id).catch((error) => {
            logger.error({ err: error, boardId: params.id }, '[PreviewJob] enqueue after element patch failed');
        });

        res.json({
            ok: true,
            sequence: latest?.sequence ?? await deps.boardStateService.peekSequence(params.id),
            serverTimestamp: latest?.serverTimestamp ?? Date.now(),
        });
    });

    router.post('/boards/:id/mutations', async (req, res) => {
        const params = parseOrSendBadRequest(boardIdParamsSchema, req.params, res);
        const query = parseOrSendBadRequest(boardAccessQuerySchema, req.query, res);
        const body = parseOrSendBadRequest(mutationsBodySchema, req.body, res);
        if (!params || !query || !body) return;

        const access = await requireBoardAccess(deps, params.id, req.userId, query.shareToken);
        if (!access.hasAccess || access.permission !== 'edit') {
            sendForbidden(res, 'No edit access to this board');
            return;
        }

        await deps.boardStateService.loadBoard(params.id);
        const results = await deps.mutationProcessor.processBatch(body.mutations, anonymousActorId(req, body.sessionId));
        void deps.previewJobService.enqueue(params.id).catch((error) => {
            logger.error({ err: error, boardId: params.id }, '[PreviewJob] enqueue after mutation failed');
        });
        res.json({ results });
    });

    return router;
}
