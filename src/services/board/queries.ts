import type { Database } from '@/db/client.js';
import { createBoardAccess } from '@/services/board/access.js';
import { createBoardCatalog } from '@/services/board/catalog.js';

export function createBoardQueries(db: Database) {
    const catalog = createBoardCatalog(db);
    const access = createBoardAccess(db, catalog);

    return {
        ...catalog,
        ...access,
    };
}
