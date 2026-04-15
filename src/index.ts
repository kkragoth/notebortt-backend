import 'dotenv/config'
import express from 'express'
import { loadConfig } from './config.js'
import { createApp } from './app/create-app.js'
import { createAppRuntime } from './app/runtime.js'
import { createSocketIoRealtimeServer } from './socketio/server.js'
import { healthRoute } from './routes/health.js'

const config = loadConfig()
const runtime = createAppRuntime(config)
const shouldRunApi = config.appRole === 'all' || config.appRole === 'api'
const shouldRunRealtime = config.appRole === 'all' || config.appRole === 'realtime'
const shouldRunWorkers = config.appRole === 'all' || config.appRole === 'worker'

const app = shouldRunApi ? createApp(runtime) : createHealthOnlyApp(runtime)

const server = app.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`)
  console.log(`[Server] Environment: ${config.nodeEnv}`)
  console.log(`[Server] Role: ${config.appRole}`)
})

const io = shouldRunRealtime
  ? createSocketIoRealtimeServer(server, {
    authService: runtime.authService,
    userService: runtime.userService,
    boardService: runtime.boardService,
    boardStateService: runtime.boardStateService,
    mutationProcessor: runtime.mutationProcessor,
    pubRedis: runtime.pubRedis,
  }, {
    corsOrigin: config.corsOrigin,
  })
  : null

if (shouldRunRealtime) {
  server.on('upgrade', runtime.upgradeHandler)

  runtime.wss.on('connection', (ws, request) => {
    runtime.wsHandler.onConnection(ws, request)
  })

  runtime.heartbeat.startHeartbeat()
}

const persistenceWorker = shouldRunWorkers ? runtime.boardPersistenceService.startWorker() : null
const redisCleanupWorker = shouldRunWorkers ? runtime.redisCleanupService.startWorker() : null
const stopPreviewWorker = shouldRunWorkers ? runtime.previewJobService.startWorker() : null

function createHealthOnlyApp(rt: typeof runtime) {
  const healthApp = express()
  healthApp.get('/health', healthRoute(rt.db, rt.redis))
  return healthApp
}

export { app, server, persistenceWorker, redisCleanupWorker, stopPreviewWorker }
export { io }
export const { db, redis } = runtime
