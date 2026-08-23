import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import type { AppConfig } from '@/shared/config.js';
import { createOpenApiDocument } from '@/shared/openapi/document.js';

export function createSwaggerRouter(config: Pick<AppConfig, 'nodeEnv'>) {
    const router = Router();

    router.use((req, res, next) => {
        if (config.nodeEnv === 'production') {
            res.status(404).json({ error: 'Not found' });
            return;
        }

        req.url = req.url || '/';
        next();
    });

    // Swagger UI needs inline scripts; relax CSP here only so the rest of the
    // API keeps the strict helmet defaults.
    router.use(helmet({ contentSecurityPolicy: false }));
    router.use('/', swaggerUi.serve);
    router.get('/', swaggerUi.setup(createOpenApiDocument(), {
        explorer: true,
        customSiteTitle: 'note-canva backend API',
    }));

    return router;
}
