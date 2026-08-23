import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { logger } from '@/shared/logger.js';
import { loadConfig } from '@/shared/config.js';
import { createDb } from '@/platform/db/client.js';
import { boards, users, workspaceMembers, workspaces } from '@/platform/db/schema.js';

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
];

async function seedDevUser(db: ReturnType<typeof createDb>, devUser: DevUser, withBoard = false) {
    const existing = await db.select().from(users).where(eq(users.email, devUser.email));
    if (existing.length > 0) {
        logger.info({ email: devUser.email }, '[Seed] User already exists, skipping');
        return existing[0];
    }

    const [user] = await db.insert(users).values({
        email: devUser.email,
        name: devUser.name,
    }).returning();

    logger.info({ userId: user.id, email: user.email }, '[Seed] Created user');

    const [workspace] = await db.insert(workspaces).values({
        name: `${devUser.name}'s Workspace`,
        ownerId: user.id,
    }).returning();

    logger.info({ workspaceId: workspace.id }, '[Seed] Created workspace');

    await db.insert(workspaceMembers).values({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'owner',
    });

    if (withBoard) {
        const [board] = await db.insert(boards).values({
            workspaceId: workspace.id,
            name: 'My First Board',
        }).returning();

        logger.info({ boardId: board.id }, '[Seed] Created board');
    }

    return user;
}

async function seed() {
    const config = loadConfig();
    const db = createDb(config.databaseUrl);

    logger.info('[Seed] Applying pending migrations...');
    await migrate(db, { migrationsFolder: 'drizzle' });

    logger.info('[Seed] Inserting dev users (idempotent)...');

    const [primaryUser, ...rest] = DEV_USERS;
    await seedDevUser(db, primaryUser, true);
    for (const devUser of rest) {
        await seedDevUser(db, devUser, false);
    }

    logger.info('[Seed] Done!');
    process.exit(0);
}

seed().catch((err) => {
    logger.error({ err }, '[Seed] Failed');
    process.exit(1);
});
