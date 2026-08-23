import { Router } from 'express';
import { createBoardAccessRoutes } from '../routes/access.routes.js';
import { createBoardMutationRoutes } from '../routes/mutations.routes.js';
import { createBoardManagementRoutes } from '../routes/management.routes.js';
import { createBoardMemberRoutes } from '../routes/members.routes.js';
import { createBoardInvitationRoutes } from '../routes/invitations.routes.js';
import { createBoardLinkSharingRoutes } from '../routes/link-sharing.routes.js';
import type { RequestHandler } from 'express';
import type { BoardService } from '../board.service.js';
import type { WorkspaceService } from '@/modules/workspaces/index.js';
import type { BoardStateService, MutationProcessor  } from '@/modules/collaboration/index.js';
import type { AuthService } from '@/modules/auth/index.js';
import type { PreviewJobService } from '@/modules/previews/index.js';
import { createOptionalAuth } from '@/modules/auth/index.js';

export function createBoardRouter(
    boardService: BoardService,
    workspaceService: WorkspaceService,
    authMiddleware: RequestHandler,
    boardStateService: BoardStateService,
    mutationProcessor: MutationProcessor,
    authService: AuthService,
    previewJobService: PreviewJobService,
) {
    const router = Router();
    const optionalAuth = createOptionalAuth(authService);
    const deps = {
        boardService,
        workspaceService,
        boardStateService,
        mutationProcessor,
        authService,
        previewJobService,
    };

    router.use(optionalAuth, createBoardAccessRoutes(deps));
    router.use(optionalAuth, createBoardMutationRoutes(deps));
    router.use(authMiddleware, createBoardManagementRoutes(deps));
    router.use(authMiddleware, createBoardMemberRoutes(deps));
    router.use(authMiddleware, createBoardInvitationRoutes(deps));
    router.use(authMiddleware, createBoardLinkSharingRoutes(deps));

    return router;
}
