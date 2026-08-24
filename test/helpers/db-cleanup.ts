import { sql } from 'drizzle-orm';
import { fixturesDb } from './fixtures.js';

const CLEANUP_LOCK_KEY = 728_913_441;
const MIGRATIONS_TABLE = '__drizzle_migrations';

function resultRows<T>(result: unknown): T[] {
    // postgres-js sessions yield row arrays directly; node-pg wraps them
    // in { rows }.
    return (Array.isArray(result) ? result : (result as { rows?: unknown }).rows ?? []) as T[];
}

/**
 * Truncates every application table in the public schema.
 *
 * Safe to call from concurrent vitest workers: the truncate runs inside a
 * transaction holding a transaction-scoped advisory lock, so parallel
 * cleanups serialize instead of deadlocking, and the lock can never leak
 * across pooled connections.
 *
 * Enabled globally via TEST_DB_GLOBAL_CLEANUP=true (see AGENTS.md); suites
 * keep working unchanged because this only removes data after each test.
 */
export async function truncateTestTables(): Promise<void> {
    const db = fixturesDb();
    await db.transaction(async (tx) => {
        await tx.execute(sql`
            select pg_advisory_xact_lock(${CLEANUP_LOCK_KEY})
        `);

        const rows = resultRows<{ tablename: string }>(await tx.execute(sql`
            select tablename from pg_tables
            where schemaname = 'public'
              and tablename <> ${MIGRATIONS_TABLE}
        `));
        const tables = rows.map((row) => `"${row.tablename}"`);
        if (tables.length === 0) {
            return;
        }

        await tx.execute(sql.raw(
            `truncate table ${tables.join(', ')} restart identity cascade`,
        ));
    });
}
