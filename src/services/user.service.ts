import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client.js';
import { oauthAccounts, users, workspaceMembers, workspaces } from '@/db/schema.js';

export interface GoogleUserInput {
  email: string
  name: string
  avatarUrl: string | null
  googleId: string
}

export function createUserService(db: Database) {
    async function upsertGoogleUser({ email, name, avatarUrl, googleId }: GoogleUserInput) {
        const existingAccount = await db
            .select()
            .from(oauthAccounts)
            .where(and(eq(oauthAccounts.provider, 'google'), eq(oauthAccounts.providerId, googleId)))
            .limit(1);

        if (existingAccount.length > 0) {
            const userId = existingAccount[0].userId;
            const existingUser = await db.select().from(users).where(eq(users.id, userId)).limit(1);
            return existingUser[0];
        }

        return db.transaction(async (tx) => {
            const [newUser] = await tx.insert(users).values({ email, name, avatarUrl }).returning();

            await tx.insert(oauthAccounts).values({
                userId: newUser.id,
                provider: 'google',
                providerId: googleId,
                email,
            });

            const [newWorkspace] = await tx
                .insert(workspaces)
                .values({ name: 'Personal Workspace', ownerId: newUser.id })
                .returning();

            await tx.insert(workspaceMembers).values({
                workspaceId: newWorkspace.id,
                userId: newUser.id,
                role: 'owner',
            });

            return newUser;
        });
    }

    async function getUserById(id: string) {
        const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
        return result[0] ?? null;
    }

    async function getUserByEmail(email: string) {
        const result = await db.select().from(users).where(eq(users.email, email)).limit(1);
        return result[0] ?? null;
    }

    return { upsertGoogleUser, getUserById, getUserByEmail };
}

export type UserService = ReturnType<typeof createUserService>
