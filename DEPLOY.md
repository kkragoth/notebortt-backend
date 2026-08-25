# Production Deploy with Docker Compose

Deployment files are at repository root (`docker-compose.yml`, `Dockerfile`, `nginx/templates`).

## 1) Edit root env file

- `.env` (copy from `.env.example` if needed)

At minimum set:
- `API_DOMAIN` in `.env`
- `GOOGLE_REDIRECT_URI=https://<API_DOMAIN>/auth/callback` in `.env`
- real secrets (`JWT_SECRET`, Google keys, DB password)

## 2) Start stack (HTTP first)

```bash
docker compose -f docker-compose.yml up -d postgres redis-realtime redis-jobs api realtime worker nginx
```

Before the first certificate is issued, nginx serves HTTP only by design.

## 3) Issue certificate

```bash
just setup-ssl
```

## 4) Switch nginx to HTTPS config

Restart nginx (it auto-detects cert files at startup):

`just setup-ssl` already restarts nginx after cert issuance.

## 5) Run migrations

The migrator installs devDependencies explicitly so `drizzle-kit` is available even though the main app runs with production env.

Before migrating a database that already has production traffic, apply the
hot-table index build first (avoids an exclusive lock on `elements`; the
tracked migration becomes a fast no-op afterwards):

```bash
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -f - < scripts/0001_elements_board_updated_at_idx.concurrently.sql
```

```bash
just run-deploy
```

## 6) Event transport rollout order

Domain events ride BullMQ queues (`board-mutations`, `board-control-events`).
When upgrading across the bus rewrite (or changing envelope code), deploy
**producers first** (`api`, `realtime`) and the **consumer** (`worker`) last,
so a newer producer never hands an envelope an older consumer cannot parse.
Undecodable payloads land on `domain-events-dlq` (7-day retention) instead of
retrying forever; size alerts on the `dlq_depth` gauge with thresholds that
tolerate transient spikes during rolling deploys.

One-time cleanup after every app is on `EVENT_BUS_TRANSPORT=bullmq`: remove
the stream keys orphaned by the old bus:

```bash
docker compose run --rm api npx tsx scripts/maintenance/delete-orphaned-event-stream.ts
```

If several deployments share one jobs Redis, set a distinct
`QUEUE_REDIS_PREFIX` per deployment — it must match across all three apps.

## 6b) Backups & the honest recovery window

**Redis is best-effort hot state, not an SLA-backed system of record.**
Postgres is the only durable store. The redis-realtime instance runs AOF
(`appendfsync everysec`) plus RDB snapshots (`save 900 1`, `300 10`), which
bounds loss on a crashed process to **≤1 second of acknowledged writes**; a
full node/volume loss recovers from the last snapshot/AOF fsync and may still
lose up to that same window. Collab-mode edits sitting only in redis at
failure time are re-derivable: clients reconnect and reconcile via board
snapshots, and previews self-heal on the next mutation.

Backups (compose `backup` profile, or run the scripts from a host with the
docker CLI):

```bash
docker compose --profile backup run --rm pg-backup     # ./backups/pg-*.dump
./scripts/redis-backup.sh                              # ./backups/redis-*-*.rdb
```

Restore validation runs nightly in CI (`backup-restore.yml`): dump → restore
into a throwaway DB → assert row counts.

Down-migrations: every forward migration in `drizzle/` carries an explicit
reverse under `drizzle/down/`. drizzle-kit does not execute them — apply
manually with psql when rolling back a schema change.

## 7) Verify

```bash
source .env
curl -i "https://$API_DOMAIN/health"
```

## 8) Renew cert (cron)

```cron
0 3 * * * cd /opt/note-canva-backend && /usr/bin/docker compose -f docker-compose.yml run --rm certbot renew --webroot -w /var/www/certbot && /usr/bin/docker compose -f docker-compose.yml restart nginx
```

## 9) Retiring the worker tier

Repeatable BullMQ schedules (`flush-dirty-boards`, `cleanup-inactive-boards`)
live in Redis and survive restarts by design. If you permanently retire or
rename the worker tier, delete its schedulers or orphan jobs keep
materializing with no consumer:

```bash
docker compose run --rm worker node --input-type=module -e "
import { Queue } from 'bullmq';
import Redis from 'ioredis';
const conn = new Redis(process.env.REDIS_JOBS_URL);
const prefix = process.env.QUEUE_REDIS_PREFIX || undefined;
for (const name of ['board-persist-flush', 'board-maintenance']) {
  const q = new Queue(name, { connection: conn, ...(prefix ? { prefix } : {}) });
  for (const s of await q.getJobSchedulers()) await q.removeJobScheduler(s.id);
  await q.close();
}
conn.disconnect();
"
```

## Shortcut

`just deploy` runs:
1. `just setup-ssl`
2. `just run-deploy`
