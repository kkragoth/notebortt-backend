import { Router } from 'express'
import swaggerUi from 'swagger-ui-express'
import type { AppConfig } from '../config.js'
import { createOpenApiDocument } from '../openapi/document.js'

export function createSwaggerRouter(config: Pick<AppConfig, 'nodeEnv'>) {
  const router = Router()

  router.use((req, res, next) => {
    if (config.nodeEnv === 'production') {
      res.status(404).json({ error: 'Not found' })
      return
    }

    req.url = req.url || '/'
    next()
  })

  router.use('/', swaggerUi.serve)
  router.get('/', swaggerUi.setup(createOpenApiDocument(), {
    explorer: true,
    customSiteTitle: 'note-canva backend API',
  }))

  return router
}
