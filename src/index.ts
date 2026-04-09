import 'dotenv/config'
import { loadConfig } from './config.js'
import { createApp } from './app/create-app.js'
import { createAppRuntime } from './app/runtime.js'
import { createSocketIoRealtimeServer } from './socketio/server.js'

const config = loadConfig()
const runtime = createAppRuntime(config)
const app = createApp(runtime)

const server = app.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`)
  console.log(`[Server] Environment: ${config.nodeEnv}`)
})

const io = createSocketIoRealtimeServer(server, {
  authService: runtime.authService,
  userService: runtime.userService,
  boardService: runtime.boardService,
  boardStateService: runtime.boardStateService,
  mutationProcessor: runtime.mutationProcessor,
  pubRedis: runtime.pubRedis,
}, {
  corsOrigin: config.corsOrigin,
})

server.on('upgrade', runtime.upgradeHandler)

runtime.wss.on('connection', (ws, request) => {
  runtime.wsHandler.onConnection(ws, request)
})

const persistenceWorker = runtime.boardPersistenceService.startWorker()
const redisCleanupWorker = runtime.redisCleanupService.startWorker()
const stopPreviewWorker = runtime.previewJobService.startWorker()
runtime.heartbeat.startHeartbeat()

export { app, server, persistenceWorker, redisCleanupWorker, stopPreviewWorker }
export { io }
export const { db, redis } = runtime
