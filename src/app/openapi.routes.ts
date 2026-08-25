import { Router } from 'express';
import type { AppConfig } from '@/shared/config.js';
import { createOpenApiDocument } from '@/app/openapi/document.js';

export function createOpenApiRouter(config: Pick<AppConfig, 'nodeEnv'>) {
    const router = Router();

    router.get('/openapi.json', (_req, res) => {
        if (config.nodeEnv === 'production') {
            res.status(404).json({ error: 'Not found' });
            return;
        }

        res.json(createOpenApiDocument());
    });

    return router;
}
