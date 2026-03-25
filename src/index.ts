import 'dotenv/config'
import express from 'express'
import { loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { createRedisClient } from './redis/client.js'
import { createCorsMiddleware } from './middleware/cors.js'
import { healthRoute } from './routes/health.js'

const config = loadConfig()
const db = createDb(config.databaseUrl)
const redis = createRedisClient(config.redisUrl)

const app = express()

app.use(createCorsMiddleware(config.corsOrigin))
app.use(express.json())

app.get('/health', healthRoute(db, redis))

const server = app.listen(config.port, () => {
  console.log(`[Server] Listening on port ${config.port}`)
  console.log(`[Server] Environment: ${config.nodeEnv}`)
})

export { app, server, db, redis }
