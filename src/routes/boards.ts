import { Router } from 'express'
import type { RequestHandler } from 'express'
import { createOptionalAuth } from '../lib/http.js'
import type { BoardService } from '../services/board.service.js'
import type { WorkspaceService } from '../services/workspace.service.js'
import type { BoardStateService } from '../services/board-state.service.js'
import type { MutationProcessor } from '../mutations/processor.js'
import type { AuthService } from '../services/auth.service.js'
import type { PreviewJobService } from '../services/preview-job.service.js'
import { createBoardAccessRoutes } from './boards/access.routes.js'
import { createBoardMutationRoutes } from './boards/mutations.routes.js'
import { createBoardManagementRoutes } from './boards/management.routes.js'
import { createBoardMemberRoutes } from './boards/members.routes.js'
import { createBoardInvitationRoutes } from './boards/invitations.routes.js'
import { createBoardLinkSharingRoutes } from './boards/link-sharing.routes.js'

export function createBoardRouter(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  authMiddleware: RequestHandler,
  boardStateService: BoardStateService,
  mutationProcessor: MutationProcessor,
  authService: AuthService,
  previewJobService: PreviewJobService,
) {
  const router = Router()
  const optionalAuth = createOptionalAuth(authService)
  const deps = {
    boardService,
    workspaceService,
    boardStateService,
    mutationProcessor,
    authService,
    previewJobService,
  }

  router.use(optionalAuth, createBoardAccessRoutes(deps))
  router.use(optionalAuth, createBoardMutationRoutes(deps))
  router.use(authMiddleware, createBoardManagementRoutes(deps))
  router.use(authMiddleware, createBoardMemberRoutes(deps))
  router.use(authMiddleware, createBoardInvitationRoutes(deps))
  router.use(authMiddleware, createBoardLinkSharingRoutes(deps))

  return router
}
