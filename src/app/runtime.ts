import { WebSocketServer } from 'ws'
import type { AppConfig } from '../config.js'
import { createDb } from '../db/client.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { createRedisClient } from '../redis/client.js'
import { createMutationProcessor } from '../mutations/processor.js'
import { createRuntimeMetrics } from '../observability/metrics.js'
import { createAuthService } from '../services/auth.service.js'
import { createBoardPersistenceService } from '../services/board-persistence.service.js'
import { createBoardPreviewRenderer } from '../services/board-preview.service.js'
import { createBoardStateService } from '../services/board-state.service.js'
import { createRedisCleanupService } from '../services/redis-cleanup.service.js'
import { createBoardService } from '../services/board.service.js'
import { createPreviewJobService } from '../services/preview-job.service.js'
import { createUserService } from '../services/user.service.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { createHeartbeatService } from '../ws/heartbeat.js'
import { createBoardRoomManager } from '../ws/room.js'
import { createUpgradeHandler } from '../ws/upgrade.js'
import { createWebSocketHandler } from '../ws/handler.js'

export function createAppRuntime(config: AppConfig) {
  const db = createDb(config.databaseUrl)
  const redis = createRedisClient(config.redisRealtimeUrl)
  const pubRedis = createRedisClient(config.redisRealtimeUrl)
  const jobsRedis = createRedisClient(config.redisJobsUrl)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

  const authService = createAuthService(config)
  const authMiddleware = createAuthMiddleware(authService)
  const userService = createUserService(db)
  const workspaceService = createWorkspaceService(db)
  const boardService = createBoardService(db)
  const metrics = createRuntimeMetrics()
  const boardStateService = createBoardStateService(redis, db, {
    enableIncrementalPersistence: config.enableIncrementalPersistence,
    metrics,
  })
  const boardPersistenceService = createBoardPersistenceService(boardStateService)
  const redisCleanupService = createRedisCleanupService(redis, boardStateService, {
    useActiveIndex: config.enableCleanupActiveIndex,
  })
  const boardPreviewRenderer = createBoardPreviewRenderer()
  const previewJobService = createPreviewJobService(db, jobsRedis, boardPreviewRenderer)
  const mutationProcessor = createMutationProcessor(boardStateService, {
    enableTargetedReads: config.enableTargetedMutationReads,
  })
  const roomManager = createBoardRoomManager()
  const heartbeat = createHeartbeatService(roomManager)
  const wsHandler = createWebSocketHandler(roomManager, boardStateService, mutationProcessor, heartbeat, pubRedis, {
    presenceWriteThrottleMs: config.presenceWriteThrottleMs,
    presenceWriteJitterMs: config.presenceWriteJitterMs,
  })
  const upgradeHandler = createUpgradeHandler(wss, authService, userService, boardService, config.corsOrigin)

  return {
    config,
    db,
    redis,
    pubRedis,
    jobsRedis,
    wss,
    authService,
    authMiddleware,
    userService,
    workspaceService,
    boardService,
    boardStateService,
    boardPersistenceService,
    redisCleanupService,
    previewJobService,
    mutationProcessor,
    roomManager,
    heartbeat,
    wsHandler,
    upgradeHandler,
    metrics,
  }
}

export type AppRuntime = ReturnType<typeof createAppRuntime>
