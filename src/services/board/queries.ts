import type { Database } from '../../db/client.js'
import { createBoardAccess } from './access.js'
import { createBoardCatalog } from './catalog.js'

export function createBoardQueries(db: Database) {
  const catalog = createBoardCatalog(db)
  const access = createBoardAccess(db, catalog)

  return {
    ...catalog,
    ...access,
  }
}
