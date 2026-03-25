import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { createRedisClient } from './redis/client.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { createAuthService } from './services/auth.service.js'
import { createUserService } from './services/user.service.js'
import { createWorkspaceService } from './services/workspace.service.js'
import { createBoardService } from './services/board.service.js'
import { createBoardStateService } from './services/board-state.service.js'
import { createMutationProcessor } from './mutations/processor.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { healthRoute } from './routes/health.js'
import { createAuthRouter } from './routes/auth.js'
import { createUserRouter } from './routes/users.js'
import { createWorkspaceRouter } from './routes/workspaces.js'
import { createBoardRouter } from './routes/boards.js'

const config = loadConfig()
const db = createDb(config.databaseUrl)
const redis = createRedisClient(config.redisUrl)

const authService = createAuthService(config)
const userService = createUserService(db)
const workspaceService = createWorkspaceService(db)
const boardService = createBoardService(db)
const boardStateService = createBoardStateService(redis, db)
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
app.use('/', createBoardRouter(boardService, workspaceService, authMiddleware, boardStateService, mutationProcessor))

const server = app.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`)
  console.log(`[Server] Environment: ${config.nodeEnv}`)
})

export { app, server, db, redis }
