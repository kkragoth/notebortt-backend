import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createDb } from './client.js'
import { users, workspaces, workspaceMembers, boards } from './schema.js'
import { eq } from 'drizzle-orm'

async function seed() {
  const config = loadConfig()
  const db = createDb(config.databaseUrl)

  console.log('[Seed] Inserting demo data (idempotent)...')

  const existing = await db.select().from(users).where(eq(users.email, 'demo@notecanva.dev'))
  if (existing.length > 0) {
    console.log('[Seed] Demo data already exists, skipping.')
    process.exit(0)
  }

  const [demoUser] = await db.insert(users).values({
    email: 'demo@notecanva.dev',
    name: 'Demo User',
  }).returning()

  console.log(`[Seed] Created user: ${demoUser.id}`)

  const [workspace] = await db.insert(workspaces).values({
    name: 'Demo Workspace',
    ownerId: demoUser.id,
  }).returning()

  console.log(`[Seed] Created workspace: ${workspace.id}`)

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: demoUser.id,
    role: 'owner',
  })

  const [board] = await db.insert(boards).values({
    workspaceId: workspace.id,
    name: 'My First Board',
  }).returning()

  console.log(`[Seed] Created board: ${board.id}`)
  console.log('[Seed] Done!')

  process.exit(0)
}

seed().catch((err) => {
  console.error('[Seed] Failed:', err)
  process.exit(1)
})
