import { Router } from 'express';
import { buildElementMutationBatch } from '../utils.js';
import {
    anonymousActorId,
    boardAccessQuerySchema,
    boardIdParamsSchema,
    mutationsBodySchema,
    parseOrSendBadRequest,
    patchElementsBodySchema,
    requireBoardAccess

} from '../routes/shared.js';
import type {BoardRouteDeps} from '../routes/shared.js';
import { APP_EVENTS } from '@/shared/events.js';
import { sendForbidden } from '@/shared/http.js';

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

        deps.events.emit(APP_EVENTS.BOARD_MUTATED, { boardId: params.id });

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
        deps.events.emit(APP_EVENTS.BOARD_MUTATED, { boardId: params.id });
        res.json({ results });
    });

    return router;
}
