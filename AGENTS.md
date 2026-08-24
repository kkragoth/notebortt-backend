# Agent Rules

## Architecture (apps split)
- Three entrypoints share one codebase: `src/apps/api.main.ts` (REST),
  `src/apps/realtime.main.ts` (Socket.IO), `src/apps/worker.main.ts`
  (all BullMQ workers + preview reactions). Compose builds them from one
  Dockerfile via `--build-arg APP=...`.
- Cross-process domain events ride a Redis Stream bus behind
  `AppEventBus` (`src/shared/events.ts`); set `EVENT_BUS_MODE=stream`
  for any multi-app deployment, `local` for single-process.
- Background schedules are BullMQ repeatable jobs registered in
  `src/app/background-jobs.ts` — never add `setInterval` loops to services.
- `createAppRuntime` members are lazy memoized getters; apps only pay for
  what they touch. Don't eagerly construct services in entrypoints.

## Database migrations
- The drizzle meta snapshot chain is stale (stops at `0002`), so
  `drizzle-kit generate` cannot diff cleanly and will demand interactive
  rename resolution. Author schema changes as hand-written
  `drizzle/NNNN_*.sql` files and append a matching entry to
  `drizzle/meta/_journal.json`; then `npm run db:migrate`.

## API Validation
- Validate every request input with Zod before business logic.
- This includes `req.params`, `req.query`, and `req.body` for every route.
- Reject invalid input with `400 Bad Request` and a clear validation message.

## How To Test Backend Changes
- Fast compile check: `just build`
- Run unit/integration tests: `just test`
- Apply migrations + seed locally: `just db-migrate && just db-seed`
- If local toolchain/network is flaky, verify in containerized Linux:
  - Compile image: `just build-docker`
  - Full dev stack (migrate + seed + run): `just dev`
