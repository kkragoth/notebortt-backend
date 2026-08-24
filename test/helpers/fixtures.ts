import {  drizzle } from 'drizzle-orm/postgres-js';
import { inArray } from 'drizzle-orm';
import postgres from 'postgres';
import type {PostgresJsDatabase} from 'drizzle-orm/postgres-js';
import * as schema from '@/platform/db/schema.js';
import { users } from '@/platform/db/schema.js';

/**
 * Shared test-data helpers.
 *
 * Two isolation strategies live here:
 *  - fixtures: real rows + explicit purge (for suites that need a shared
 *    connection pool, e.g. supertest apps)
 *  - RollbackDb: every write happens inside one open transaction that is
 *    rolled back at teardown — zero residue by construction
 */

const TEST_DB_URL = process.env.TEST_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? 'postgres://notecanva:notecanva@localhost:5432/notecanva_test';

let singletonClient: postgres.Sql | undefined;
let singletonDb: PostgresJsDatabase<typeof schema> | undefined;

/** Lazily-shared pool for fixture factories. */
export function fixturesDb(): PostgresJsDatabase<typeof schema> {
    if (!singletonDb) {
        singletonClient = postgres(TEST_DB_URL, { max: 2 });
        singletonDb = drizzle(singletonClient, { schema });
    }
    return singletonDb;
}

export async function closeFixtures(): Promise<void> {
    if (singletonClient) {
        await singletonClient.end({ timeout: 5 });
        singletonClient = undefined;
        singletonDb = undefined;
    }
}

// ── fixtures ─────────────────────────────────────────────────────────────

const createdUserIds: string[] = [];

export interface TestUser {
    id: string
    email: string
    name: string
}

export async function createTestUser(overrides: Partial<{ email: string; name: string }> = {}): Promise<TestUser> {
    const db = fixturesDb();
    const [user] = await db.insert(users).values({
        email: overrides.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        name: overrides.name ?? 'Test User',
    }).returning({ id: users.id, email: users.email, name: users.name });
    createdUserIds.push(user.id);
    return user;
}

/** Deletes everything the factories created. Call in afterAll/afterEach. */
export async function purgeFixtures(): Promise<void> {
    if (createdUserIds.length > 0) {
        await fixturesDb().delete(users).where(inArray(users.id, [...createdUserIds]));
    }
    createdUserIds.length = 0;
}

// ── rollback transaction harness ─────────────────────────────────────────

class RollbackSignal extends Error {}

type TxDb = Parameters<Parameters<PostgresJsDatabase<typeof schema>['transaction']>[0]>[0];

export interface RollbackTxHandle {
    /** Drizzle bound to the open transaction — pass this into code under test. */
    db: TxDb
    /** Aborts and closes everything. Idempotent-safe for afterAll. */
    rollback: () => Promise<void>
}

export async function beginRollbackTx(): Promise<RollbackTxHandle> {
    const client = postgres(TEST_DB_URL, { max: 1 });
    const outer = drizzle(client, { schema });

    let txDb!: TxDb;
    let triggerRollback!: (e: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });

    const finished = outer.transaction(async (tx) => {
        txDb = tx;
        markStarted();
        await new Promise<never>((_, reject) => {
            triggerRollback = reject;
        });
    }).catch((e) => {
        if (!(e instanceof RollbackSignal)) {
            throw e;
        }
    });

    await started;

    return {
        db: txDb,
        rollback: async () => {
            triggerRollback(new RollbackSignal('test teardown'));
            await finished;
            await client.end({ timeout: 5 });
        },
    };
}
