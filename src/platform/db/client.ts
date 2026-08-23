import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/platform/db/schema.js';

export interface DbPoolOptions {
    max?: number
    idleTimeoutSeconds?: number
    connectTimeoutSeconds?: number
    statementTimeoutMs?: number
    applicationName?: string
}

export function createDb(databaseUrl: string, options: DbPoolOptions = {}) {
    const max = options.max ?? 10;
    const idleTimeout = options.idleTimeoutSeconds ?? 20;
    const connectTimeout = options.connectTimeoutSeconds ?? 5;
    const statementTimeout = options.statementTimeoutMs ?? 15_000;

    const client = postgres(databaseUrl, {
        max,
        idle_timeout: idleTimeout,
        connect_timeout: connectTimeout,
        connection: {
            application_name: options.applicationName ?? 'note-canva-backend',
            // Guardrail so a single runaway query cannot pin a pool slot forever.
            ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
        },
    });
    return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>
