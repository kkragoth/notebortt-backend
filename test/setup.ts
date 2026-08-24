import 'dotenv/config';

/**
 * Integration suites hit live Postgres and Redis. Fail fast with an
 * actionable message instead of cryptic connection timeouts mid-suite.
 */
async function assertInfraAvailable(): Promise<void> {
    const checks: Array<{ name: string; probe: Promise<unknown> }> = [];
    const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

    if (dbUrl) {
        const postgres = (await import('postgres')).default;
        const sql = postgres(dbUrl, { connect_timeout: 3, max: 1 });
        checks.push({
            name: `Postgres (${dbUrl.replace(/:\/\/[^@]*@/, '://***@')})`,
            probe: sql`select 1`.then(() => sql.end()),
        });
    }

    for (const envKey of ['REDIS_REALTIME_URL', 'REDIS_JOBS_URL']) {
        const url = process.env[envKey];
        if (!url) continue;
        const { default: Redis } = await import('ioredis');
        const client = new Redis(url, {
            retryStrategy: () => null,
            maxRetriesPerRequest: 1,
            connectTimeout: 3000,
            lazyConnect: false,
        });
        checks.push({
            name: `${envKey} (${url})`,
            probe: client.ping().finally(() => client.disconnect()),
        });
    }

    const results = await Promise.allSettled(checks.map((check) => check.probe));
    const failures = checks.filter((_, index) => results[index]?.status === 'rejected');

    if (failures.length > 0) {
        console.error('\n[vitest] Required services are unreachable:');
        for (const failure of failures) {
            console.error(`  - ${failure.name}`);
        }
        console.error('\nStart them with: docker compose up -d postgres redis-realtime redis-jobs\n');
        process.exit(1);
    }
}

await assertInfraAvailable();
