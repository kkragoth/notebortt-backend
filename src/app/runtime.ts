import type { AppConfig } from '@/shared/config.js';
import { createDb } from '@/platform/db/client.js';
import { createRedisClient } from '@/platform/redis/client.js';
import { createRuntimeMetrics } from '@/platform/observability/metrics.js';
import {
    createAuthMiddleware,
    createAuthService,
} from '@/modules/auth/index.js';
import { createUserService } from '@/modules/users/index.js';
import { createWorkspaceService } from '@/modules/workspaces/index.js';
import { createBoardService } from '@/modules/boards/index.js';
import { createBillingService } from '@/modules/billing/index.js';
import {
    createBoardPersistenceService,
    createBoardStateService,
    createMutationProcessor,
    createRedisCleanupService,
} from '@/modules/collaboration/index.js';
import {
    createBoardPreviewRenderer,
    createPreviewJobService,
} from '@/modules/previews/index.js';

export function createAppRuntime(config: AppConfig) {
    const db = createDb(config.databaseUrl);
    const redis = createRedisClient(config.redisRealtimeUrl);
    const pubRedis = createRedisClient(config.redisRealtimeUrl);
    const jobsRedis = createRedisClient(config.redisJobsUrl, { maxRetriesPerRequest: null });

    const authService = createAuthService(config);
    const authMiddleware = createAuthMiddleware(authService);
    const userService = createUserService(db);
    const workspaceService = createWorkspaceService(db);
    const boardService = createBoardService(db);
    const billingService = createBillingService(config, db, userService, workspaceService, boardService);
    const metrics = createRuntimeMetrics();
    const boardStateService = createBoardStateService(redis, db, {
        enableIncrementalPersistence: config.enableIncrementalPersistence,
        metrics,
    });
    const boardPersistenceService = createBoardPersistenceService(boardStateService);
    const redisCleanupService = createRedisCleanupService(redis, boardStateService, {
        useActiveIndex: config.enableCleanupActiveIndex,
    });
    const boardPreviewRenderer = createBoardPreviewRenderer();
    const previewJobService = createPreviewJobService(db, jobsRedis, boardPreviewRenderer);
    const mutationProcessor = createMutationProcessor(boardStateService, {
        enableTargetedReads: config.enableTargetedMutationReads,
    });

    return {
        config,
        db,
        redis,
        pubRedis,
        jobsRedis,
        authService,
        authMiddleware,
        userService,
        workspaceService,
        boardService,
        billingService,
        boardStateService,
        boardPersistenceService,
        redisCleanupService,
        previewJobService,
        mutationProcessor,
        metrics,
    };
}

export type AppRuntime = ReturnType<typeof createAppRuntime>
