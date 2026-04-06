import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import { WebSocketServer } from 'ws'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { createRedisClient } from './redis/client.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { createAuthService } from './services/auth.service.js'
import { createUserService } from './services/user.service.js'
import { createWorkspaceService } from './services/workspace.service.js'
import { createBoardService } from './services/board.service.js'
import { createBoardStateService } from './services/board-state.service.js'
import { createBoardPreviewRenderer } from './services/board-preview.service.js'
import { createPreviewJobService } from './services/preview-job.service.js'
import { createMutationProcessor } from './mutations/processor.js'
import { createCompactionService } from './mutations/compaction.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { healthRoute } from './routes/health.js'
import { createAuthRouter } from './routes/auth.js'
import { createUserRouter } from './routes/users.js'
import { createWorkspaceRouter } from './routes/workspaces.js'
import { createBoardRouter } from './routes/boards.js'
import { createBoardRoomManager } from './ws/room.js'
import { createHeartbeatService } from './ws/heartbeat.js'
import { createUpgradeHandler } from './ws/upgrade.js'
import { createWebSocketHandler } from './ws/handler.js'

const config = loadConfig()
const db = createDb(config.databaseUrl)
const redis = createRedisClient(config.redisUrl)
const pubRedis = createRedisClient(config.redisUrl)

const authService = createAuthService(config)
const userService = createUserService(db)
const workspaceService = createWorkspaceService(db)
const boardService = createBoardService(db)
const boardStateService = createBoardStateService(redis, db)
const boardPreviewRenderer = createBoardPreviewRenderer()
const previewJobService = createPreviewJobService(db, redis, boardPreviewRenderer)
const mutationProcessor = createMutationProcessor(boardStateService, db)
const authMiddleware = createAuthMiddleware(authService)

const app = express()

app.use(createCorsMiddleware(config.corsOrigin))
app.use(express.json())
app.use(cookieParser())

app.get('/health', healthRoute(db, redis))
app.use('/auth', createAuthRouter(config, authService, userService, db))
app.use('/users', createUserRouter(userService, authMiddleware))
app.use('/', createWorkspaceRouter(workspaceService, authMiddleware))
app.use('/', createBoardRouter(boardService, workspaceService, authMiddleware, boardStateService, mutationProcessor, authService, previewJobService))

const compactionService = createCompactionService(db, redis)

const wss = new WebSocketServer({ noServer: true })
const roomManager = createBoardRoomManager()
const heartbeat = createHeartbeatService(roomManager)
const wsHandler = createWebSocketHandler(roomManager, boardStateService, mutationProcessor, heartbeat, db, pubRedis)

const server = app.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`)
  console.log(`[Server] Environment: ${config.nodeEnv}`)
})

server.on('upgrade', createUpgradeHandler(wss, authService, userService))

wss.on('connection', (ws, request) => {
  wsHandler.onConnection(ws, request)
})

const compactionTimer = compactionService.startCompactionInterval()
const stopPreviewWorker = previewJobService.startWorker()
heartbeat.startHeartbeat()

export { app, server, db, redis, compactionTimer, stopPreviewWorker }
