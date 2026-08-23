import { createBoardAccess } from '../domain/access.js';
import { createBoardCatalog } from '../domain/catalog.js';
import type { Database } from '@/platform/db/client.js';

export function createBoardQueries(db: Database) {
    const catalog = createBoardCatalog(db);
    const access = createBoardAccess(db, catalog);

    return {
        ...catalog,
        ...access,
    };
}
