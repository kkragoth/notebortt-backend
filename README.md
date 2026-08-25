# notebortt-backend

Backend for [notebortt.web.app](https://notebortt.web.app/) — a collaborative
note canvas with live multi-user editing, previews and billing.

## Architecture

One codebase, three deployables. Every cross-app interaction rides Redis —
no direct service-to-service calls.

```
                        ┌────────────────────────────┐
  browser ── one origin ─► nginx (:80/:443)            │
                        │   /            → api       │
                        │   /socket.io/  → realtime  │
                        └────────────────────────────┘
     ┌──────────────┐  ┌───────────────┐  ┌─────────────────┐
     │ api          │  │ realtime      │  │ worker          │
     │ Express REST │  │ Socket.IO     │  │ BullMQ workers  │
     │              │  │ CRDT/presence │  │ preview render  │
     └──────┬───────┘  └──────┬────────┘  │ bull-board      │
            │                 │           └────────┬────────┘
            │                 │                  │
            │   BullMQ domain-event queues       │
            │  (BOARD_MUTATED, BOARD_EDITORS_LEFT)
            ▼                 ▼                  ▼
     ┌──────────────┐  ┌───────────────┐  ┌──────────────┐
     │ Postgres     │  │ redis-realtime│  │ redis-jobs   │
     │ (Drizzle)    │  │ state/pub-sub │  │ queues/sched │
     └──────────────┘  └───────────────┘  └──────────────┘
```

- **api** (`src/apps/api.main.ts`) — REST under `/api/v1`, auth (Google OAuth +
  JWT refresh rotation), billing (Stripe), health/metrics.
- **realtime** (`src/apps/realtime.main.ts`) —
  Socket.IO server: CRDT sessions (Yjs), mutation batches, presence. Scales
  horizontally via the socket.io redis adapter + a redis-backed participants
  store; needs sticky sessions when running >1 replica.
- **worker** (`src/apps/worker.main.ts`) — owns all background processing:
  repeatable board-persistence flush (30s) and cleanup schedules via BullMQ
  job schedulers, preview rendering, consumption of the domain-event
  queues, and the Bull Board dashboard (`/admin/queues` on its metrics
  surface).

**Event bus** — `AppEventBus` (`src/shared/events.ts`). `EVENT_BUS_TRANSPORT=bullmq`
emits/consumes over dedicated BullMQ queues (`board-mutations`,
`board-control-events`) with a versioned envelope, retry/backoff, and a
dead-letter queue for undecodable payloads; `local` uses in-process handlers
for single-process runs and tests.

**Board state model** — hot state lives in redis-realtime (elements hash,
sequence, dirty tracking, presence); a repeatable job flushes dirty boards to
Postgres incrementally, epoch-guarded so racing flushes never lose writes.

**Single origin** — nginx path-splits `/socket.io/` → realtime and everything
else → api, identically in production and dev (`dev-proxy` on `:8080`).

## Layout

```
src/
  apps/          entrypoints + shared lifecycle shell
  app/           composition root (runtime, create-app, background jobs)
  modules/       auth users workspaces boards billing collaboration realtime previews
  platform/      db (Drizzle) · redis · jobs (BullMQ) · observability
  shared/        config (zod) · events · http/errors/validation helpers
test/            vitest suites (integration against real services)
nginx/           prod templates + dev proxy conf
drizzle/         SQL migrations (hand-authored, see AGENTS.md)
```

Module boundaries are enforced by `eslint-plugin-boundaries`: outside a module,
import only its `index.js`.

## Development

```bash
just dev           # postgres + redis + all three apps behind :8080
just test          # vitest (requires docker services up; fails fast if not)
just build         # tsc
just db-seed       # seed local data
```

Frontend points at `http://localhost:8080` for both REST and Socket.IO.
Debug UIs (adminer, redis-commander) live behind `--profile debug`.

## Migrations

Single squashed baseline (`drizzle/0000_init.sql`) with a clean snapshot
chain — `drizzle-kit generate` / `migrate` work normally.

## Configuration

All configuration is environment-driven — see `.env.example` for every variable
(`DATABASE_URL`, `REDIS_*`, `EVENT_BUS_TRANSPORT`, Stripe, ports, intervals).
