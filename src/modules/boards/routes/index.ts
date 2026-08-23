import { Router } from 'express';
import { createBoardAccessRoutes } from '../routes/access.routes.js';
import { createBoardMutationRoutes } from '../routes/mutations.routes.js';
import { createBoardManagementRoutes } from '../routes/management.routes.js';
import { createBoardMemberRoutes } from '../routes/members.routes.js';
import { createBoardInvitationRoutes } from '../routes/invitations.routes.js';
import { createBoardLinkSharingRoutes } from '../routes/link-sharing.routes.js';
import type { RequestHandler } from 'express';
import type { BoardRouteDeps } from './shared.js';
import { createOptionalAuth } from '@/modules/auth/index.js';

export interface BoardRouterOptions extends BoardRouteDeps {
    authMiddleware: RequestHandler
}

export function createBoardRouter({
    boardService,
    workspaceService,
    authMiddleware,
    boardStateService,
    mutationProcessor,
    authService,
    previewJobService,
    events,
}: BoardRouterOptions) {
    const router = Router();
    const optionalAuth = createOptionalAuth(authService);
    const deps: BoardRouteDeps = {
        boardService,
        workspaceService,
        boardStateService,
        mutationProcessor,
        authService,
        previewJobService,
        events,
    };

    router.use(optionalAuth, createBoardAccessRoutes(deps));
    router.use(optionalAuth, createBoardMutationRoutes(deps));
    router.use(authMiddleware, createBoardManagementRoutes(deps));
    router.use(authMiddleware, createBoardMemberRoutes(deps));
    router.use(authMiddleware, createBoardInvitationRoutes(deps));
    router.use(authMiddleware, createBoardLinkSharingRoutes(deps));

    return router;
}
