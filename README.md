# notebortt-backend

Backend for [notebortt.web.app](https://notebortt.web.app/) — a collaborative
note canvas with live multi-user editing, previews and billing.

## Architecture

One codebase, three deployables (`api`, `realtime`, `worker`). Every
cross-app interaction rides Redis queues or pub/sub — no direct
service-to-service calls. **Postgres is the only durable system of record**;
Redis holds hot state whose recovery is a best-effort mechanism with an
explicit loss window, not an SLA (see *Durability & recovery* below).

```
                          ┌─────────────────────────────┐
    browser ─ one origin ─► nginx (:80/:443)               │
                          │   /            → api         │
                          │   /socket.io/  → realtime    │
                          └─────────────────────────────┘
       ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐
       │ api          │  │ realtime       │  │ worker             │
       │ Express REST │  │ Socket.IO      │  │ BullMQ consumers:  │
       │ contract-    │  │ CRDT/presence  │  │  preview render    │
       │ tested REST  │  │ handshake auth │  │  persist flush     │
       └──────┬───────┘  │ byte caps +    │  │  cleanup schedules │
              │          │ token bucket   │  │  domain events     │
              │          └───────┬────────┘  │ Bull Board :3002   │
              │                  │           └─────────┬──────────┘
              │  emit BOARD_MUTATED / BOARD_EDITORS_LEFT
              │  (versioned envelope + traceparent)   consume
              ▼                  ▼                     ▼
       ┌───────────────────────────────────────────────────────┐
       │ redis-jobs (BullMQ)                                   │
       │  board-mutations ──┐                                  │
       │  board-control-events ── isolated consumer pools       │
       │  board-preview · board-persist-flush · board-maintenance│
       │  domain-events-dlq (never retried, 7d retention)       │
       └───────────────────────────┬───────────────────────────┘
                                   │ flush dirty boards (epoch-guarded)
       ┌──────────────┐  ┌─────────┴─────┐  ┌────────────────────┐
       │ Postgres     │◄─┤ redis-realtime│  │ OTLP collector     │
       │ source of    │  │ AOF everysec  │  │ (optional; traces) │
       │ truth        │  │ + RDB snaps   │  └────────────────────┘
       └──────────────┘  └───────────────┘
```

### The three apps

- **api** (`src/apps/api.main.ts`) — REST under `/api/v1`: auth (Google OAuth
  with PKCE + JWT refresh rotation), boards/workspaces/billing, health and
  metrics. Its route table is gated by `test/openapi.contract.test.ts` — any
  route that exists but is undocumented (or vice versa) fails CI. Emits
  domain events after applied mutations; never opens worker-owned queue
  handles.
- **realtime** (`src/apps/realtime.main.ts`) — Socket.IO server: CRDT
  sessions (Yjs), mutation batches, presence. Scales horizontally via the
  socket.io redis adapter + a redis-backed participants store; sticky
  sessions required beyond one replica. Connections must present a valid JWT
  or an explicit share-token opt-in at handshake; per-board access is
  re-checked on every join.
- **worker** (`src/apps/worker.main.ts`) — owns all background processing:
  preview rendering, the repeatable board-persistence flush (30s), cleanup
  schedules, the domain-event consumers, and the Bull Board dashboard
  (`/admin/queues` on its metrics surface). It is the only app allowed to
  open handles to worker-owned queues.

### Cross-app events (`AppEventBus`, `src/shared/events.ts`)

Two transports behind one interface:

- `EVENT_BUS_TRANSPORT=bullmq` (any multi-app deployment): `emit()` awaits a
  BullMQ enqueue before returning, so the trigger is durably queued before
  the HTTP/socket response goes out — but enqueue failure never fails the
  primary operation (the mutation is already applied; delivery degrades,
  `domain_events_enqueue_failed_total` ticks).
- `EVENT_BUS_TRANSPORT=local` (single-process dev, tests): in-process
  handlers awaited inline.

Delivery semantics:

- **Envelope v1** — `{ schemaVersion, producerId, timestamp, data }`,
  Zod-validated by the consumer. Undecodable payloads (bad envelope,
  unknown future `schemaVersion`, unknown event, invalid payload) are parked
  on `domain-events-dlq` — never retried, 7-day retention, surfaced via the
  `dlq_depth` gauge plus structured summary logs.
- **Coalescing** — deterministic dedup ids keyed on event+boardId collapse
  bursts into roughly one queued trigger per short window; handlers read the
  latest board state when they run, so collapsed duplicates lose nothing.
- **Isolation** — separate worker pools per queue, so a `BOARD_MUTATED`
  burst cannot delay time-sensitive `BOARD_EDITORS_LEFT` flush enqueues.
- **Retries** — handler failures are retried with exponential backoff;
  handlers must be idempotent.
- **Tracing** — the producer injects the W3C `traceparent`; the consumer
  restores that context around dispatch, so api → queue → worker → DB spans
  form one chain.

### Board state model

Hot state lives in redis-realtime: elements hash, sequence, presence,
per-element dirty sets. Mutations apply under a per-board lock (2s
acquisition timeout → fast 503 instead of unbounded queuing). The worker
flushes dirty boards to Postgres incrementally; each flush snapshots the
board's dirty epoch and clears markers through a Lua compare-and-clear — if
an editor mutates mid-flush, the stale clear is rejected and the new window
survives. A crashed flush leaves every marker intact (verified by
`test/flush.crash-boundary.test.ts`). While collaborators are present, a
conditional grace re-arm keeps writes in deferred-persistence collab mode;
a solo board's own mutations can never flip it to deferred.

### Observability

- Fixed Prometheus catalog (`src/platform/observability/metrics.ts`);
  names/labels are code-declared, unbounded identifiers like `boardId` are
  never labels. Default metrics are prefixed per app (`api_`, `realtime_`,
  `worker_`); business metrics stay canonical across apps.
- Gauges for dirty backlog/age, per-queue depth and oldest-job age, DLQ
  depth, DB pool stats, worker heap; Socket.IO RED metrics per event type.
- OpenTelemetry tracing is zero-cost until `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set. Root sampling = parent-based(board rotation ∥ ratio): requests whose
  URL carries a board id are force-sampled when `hash(boardId + ISO-week)`
  lands in a fixed 5% bucket (UTC weeks, so all replicas agree); everything
  else uses a 10% ratio. Socket.IO handshakes, probe paths, and lock-polling
  redis commands are suppressed from spans.
- Performance baseline: `just bench` measures REST mutation latency +
  Socket.IO throughput against `bench/BASELINE.md`; CI compares nightly runs
  against a rolling median (>10% p95 regression fails the gate).

### Durability & recovery

- redis-realtime persists with AOF (`appendfsync everysec`) plus RDB
  snapshots. Worst case on a crashed process: ~1s of acknowledged writes; a
  full node loss recovers to the last snapshot. This is best-effort hot
  state recovery — clients reconcile via board snapshots on reconnect, and
  previews self-heal on the next mutation.
- Backups: `scripts/pg-backup.sh` (custom-format dump, retention-bounded)
  and `scripts/redis-backup.sh` (BGSAVE + snapshot copy), exposed via the
  compose `backup` profile into `./backups`. Nightly CI
  (`backup-restore.yml`) restores the latest dump into a throwaway database
  and asserts row counts.
- Uniform container healthchecks (`/healthz` on all three apps), bounded
  Node heap (`--max-old-space-size=512`), and migrations kept out of app
  startup (standalone `migrator` service / CI step).

### Single origin

nginx path-splits `/socket.io/` → realtime and everything else → api,
identically in production and dev (`dev-proxy` on `:8080`).

## Layout

```
src/
  apps/          entrypoints + shared lifecycle shell
  app/           composition root (runtime, create-app, background jobs, openapi)
  modules/       auth users workspaces boards billing collaboration realtime previews
  platform/      db (Drizzle) · redis · jobs (BullMQ) · observability (metrics + tracing)
  shared/        config (zod) · events bus · trace-context · http/errors/validation
test/            vitest suites (integration against real services)
scripts/         bench fixture/runner · backups · one-off maintenance
nginx/           prod templates + dev proxy conf
drizzle/         SQL migrations (+ drizzle/down/ reverses, see AGENTS.md)
.github/workflows  ci · bench gate · nightly backup-restore validation
```

Module boundaries are enforced by `eslint-plugin-boundaries`: outside a module,
import only its `index.js`.

## Development

```bash
just dev           # postgres + redis + all three apps behind :8080
just test          # vitest (requires docker services up; fails fast if not)
just build         # tsc
just bench         # REST + Socket.IO benchmark vs BASELINE.md
just db-reset      # recreate the dev DB from the migration baseline
just db-seed       # seed local data
```

Frontend points at `http://localhost:8080` for both REST and Socket.IO.
Debug UIs (adminer, redis-commander) live behind `--profile debug`; Bull Board
on the worker's metrics port (`:3002/admin/queues`, dev default on).

## Migrations

Squashed baseline (`drizzle/0000_init.sql`) plus incremental forward files,
each with an explicit reverse in `drizzle/down/` (apply manually via psql —
drizzle-kit never runs downs). Hot-table indexes ship a `CONCURRENTLY`
variant under `scripts/` to apply before migrating a production database.

## Configuration

All configuration is environment-driven — see `.env.example` for every variable
(`DATABASE_URL`, `REDIS_*`, `EVENT_BUS_TRANSPORT`, Stripe, ports, intervals).
