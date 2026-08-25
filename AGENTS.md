# Agent Rules

## Architecture (apps split)
- Three entrypoints share one codebase: `src/apps/api.main.ts` (REST),
  `src/apps/realtime.main.ts` (Socket.IO), `src/apps/worker.main.ts`
  (all BullMQ workers + preview reactions). Compose builds them from one
  Dockerfile via `--build-arg APP=...`.
- Cross-process domain events ride BullMQ queues behind `AppEventBus`
  (`src/shared/events.ts`); set `EVENT_BUS_TRANSPORT=bullmq` for any
  multi-app deployment, `local` for single-process.
- Background schedules are BullMQ repeatable jobs registered in
  `src/app/background-jobs.ts` — never add `setInterval` loops to services.
- `createAppRuntime` members are lazy memoized getters; apps only pay for
  what they touch. Don't eagerly construct services in entrypoints.

## Database migrations
- History is squashed to a single baseline (`0000_init.sql`); the snapshot
  chain is clean, so `drizzle-kit generate` works normally.
- drizzle-kit swallows connection errors from `migrate` (silent exit 1).
  If a migrate "does nothing", check credentials first — don't debug
  Postgres versions.

## API Validation
- Validate every request input with Zod before business logic.
- This includes `req.params`, `req.query`, and `req.body` for every route.
- Reject invalid input with `400 Bad Request` and a clear validation message.

## No magic strings
- Never inline string literals for values with cross-file meaning (Redis keys,
  queue/job names, event names, metric names, header/cookie names, config
  scopes, cache key prefixes). Declare a hardcoded exported constant next to
  the thing that owns the concept, and import it everywhere else.
- Reuse existing constants instead of re-declaring them (e.g. board-state
  Redis keys live in `src/modules/collaboration/board-state/keys.ts`).
- One-off display strings, log messages, and error copy are exempt.

## Observability / metrics
- All metrics live in a fixed catalog (`METRIC_CATALOG` in
  `src/platform/observability/metrics.ts`). Register new metrics there
  first; dynamic/unknown metric names are dropped at runtime.
- Static label names only. Never use unbounded identifiers (`boardId`,
  `userId`, route paths) as labels; label values must come from bounded
  code-level enums.
- Counter names carry the `_total` suffix in the catalog (prom-client does
  not append it); summaries end in `_duration_ms`.
- Per-process default metrics are prefixed by app (`api_`/`realtime_`/
  `worker_`) — pass `app` when calling `createAppRuntime`. Business metric
  names stay unprefixed so dashboards work across apps.
- Gauge values that need sampling are computed at scrape time via
  `metrics.registerCollector(...)` (`src/app/metrics-collectors.ts`) — no
  background timers for metrics.

## Testing hygiene
- Suites must not leak state between tests. Prefer rollback transactions
  (`beginRollbackTx`) or explicit fixture purges (`purgeFixtures`).
  `TEST_DB_GLOBAL_CLEANUP=true just test` enables a global truncate hook
  for debugging cross-test contamination.

## How To Test Backend Changes
- Fast compile check: `just build`
- Run unit/integration tests: `just test`
- Performance benchmark (boots api+realtime locally): `just bench`
  - Regenerate `bench/BASELINE.md`: `UPDATE_BASELINE=true just bench`
  - CI: `.github/workflows/bench.yml` — informational on PRs, hard gate on
    the nightly schedule (>10% tail-latency regression vs rolling median)
- Apply migrations + seed locally: `just db-migrate && just db-seed`
- If local toolchain/network is flaky, verify in containerized Linux:
  - Compile image: `just build-docker`
  - Full dev stack (migrate + seed + run): `just dev`
