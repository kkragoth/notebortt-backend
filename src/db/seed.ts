import 'dotenv/config'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadConfig } from '../config.js'
import { createDb } from './client.js'
import { users, workspaces, workspaceMembers, boards } from './schema.js'
import { eq } from 'drizzle-orm'

interface DevUser {
  email: string
  name: string
}

const DEV_USERS: DevUser[] = [
  { email: 'dev@notecanva.dev', name: 'Dev User' },
  { email: 'dev1@notecanva.dev', name: 'Dev User 1' },
  { email: 'dev2@notecanva.dev', name: 'Dev User 2' },
  { email: 'dev3@notecanva.dev', name: 'Dev User 3' },
  { email: 'dev4@notecanva.dev', name: 'Dev User 4' },
]

async function seedDevUser(db: ReturnType<typeof createDb>, devUser: DevUser, withBoard = false) {
  const existing = await db.select().from(users).where(eq(users.email, devUser.email))
  if (existing.length > 0) {
    console.log(`[Seed] User ${devUser.email} already exists, skipping.`)
    return existing[0]
  }

  const [user] = await db.insert(users).values({
    email: devUser.email,
    name: devUser.name,
  }).returning()

  console.log(`[Seed] Created user: ${user.id} (${user.email})`)

  const [workspace] = await db.insert(workspaces).values({
    name: `${devUser.name}'s Workspace`,
    ownerId: user.id,
  }).returning()

  console.log(`[Seed] Created workspace: ${workspace.id}`)

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId: user.id,
    role: 'owner',
  })

  if (withBoard) {
    const [board] = await db.insert(boards).values({
      workspaceId: workspace.id,
      name: 'My First Board',
    }).returning()

    console.log(`[Seed] Created board: ${board.id}`)
  }

  return user
}

async function seed() {
  const config = loadConfig()
  const db = createDb(config.databaseUrl)

  console.log('[Seed] Applying pending migrations...')
  await migrate(db, { migrationsFolder: 'drizzle' })

  console.log('[Seed] Inserting dev users (idempotent)...')

  const [primaryUser, ...rest] = DEV_USERS
  await seedDevUser(db, primaryUser, true)
  for (const devUser of rest) {
    await seedDevUser(db, devUser, false)
  }

  console.log('[Seed] Done!')
  process.exit(0)
}

seed().catch((err) => {
  console.error('[Seed] Failed:', err)
  process.exit(1)
})
