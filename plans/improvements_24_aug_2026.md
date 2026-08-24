# Backend Improvement Plan — 24 Aug 2026

Status: DRAFT — for review by the team before a coding agent starts.
Constraint: **stay on Node.js + Express**. No framework rewrite (no NestJS, no Fastify, no Hono).

This document is the handoff artifact for an implementing coding agent. Section 0 is the
agent's entry point. Sections 1–2 are the adverse review of the *current* system. Section 3 is
the target architecture. Section 4 is the phased implementation plan (the actual work).
Section 5 is the adverse review of *this plan* — read it before trusting anything in Section 4.

---

## 0. How to use this document (read me first, implementer)

- The system is one TypeScript codebase with three deployables (`api`, `realtime`, `worker`),
  a Redis-first board-state store, a hand-rolled Redis Stream event bus, BullMQ background
  jobs, Drizzle/Postgres persistence, and Socket.IO realtime.
- **Verification commands** (must pass at every phase boundary):
  - `just build` (tsc + tsc-alias)
  - `npm run lint` (eslint, includes `eslint-plugin-boundaries` module rules)
  - `just test` (vitest; requires Docker postgres + redis up — runs `just test-db` first)
  - Containerized sanity: `just build-docker`
- **Conventions to preserve**: module boundaries enforced by `eslint-plugin-boundaries`
  (import only each module's `index.js` from outside); Zod validation on every route input;
  structured pino logging; lazy memoized getters in `createAppRuntime`; no `setInterval` in
  services (BullMQ repeatable jobs instead). Do not add comments unless they explain a
  non-obvious invariant.
- **Do not reorder phases.** Phase 1 changes the event plumbing; phases 3–7 depend on the
  invariants it establishes. Each phase must leave `just test` green and both transports
  (`EVENT_BUS_MODE=local|stream`) functional before moving on.
- **File references** use `file:line`. They are accurate at time of writing (24 Aug 2026).

---

## 1. Adverse review of the current architecture

The codebase is genuinely well-disciplined: single-funnel mutation processor, enforced module
boundaries, Zod on every input, real integration tests, a clean lazy composition root. The
criticism below is therefore about **architectural choices**, not code quality.

### 1.1 The custom Redis Stream event bus is the single worst component

`src/shared/events.ts` (351 lines) is a hand-rolled distributed message broker: consumer
groups, `XREADGROUP` blocking reads, `XAUTOCLAIM` reclaim sweeps, PEL management, poison-entry
dropping, stale-consumer pruning, a dedicated reader connection so `BLOCK` never stalls
publishes. This is production-critical distributed-systems code maintained by hand, and it is
wildly disproportionate to what it delivers.

1. **Machinery-to-value ratio is absurd.** The bus has exactly **2 events** and **1 consumer**
   (the worker, to wake the preview renderer). Producers: `mutations.routes.ts:38,61`,
   `mutation-batch.handler.ts:42`, `tick-persistence.ts:66`, `disconnect.handler.ts:21`.
   Consumer: `worker.main.ts:52-61`. ~350 lines of subtle stream semantics exist to trigger an
   SVG render that is already debounced and deduped inside BullMQ (`preview-job.service.ts:65-104`).
   BullMQ, which this codebase already uses, provides delivery, retries, dedup, delayed jobs,
   and Prometheus metrics for free.

2. **Data loss is baked into the design.** `MAXLEN ~10000` trimming (`events.ts:22-28`)
   means a worker offline for >10k events permanently loses triggers. The comment admits
   `flush-on-editors-left does not self-heal`. For the only event in the system that does not
   self-heal, the design guarantees eventual loss under burst. That is a known, accepted
   reliability defect in production-critical infrastructure.

3. **"At-least-once" is only true on the consumer side.** `emit` is fire-and-forget
   (`events.ts:272-280`): `void redis.xadd(...).catch(...)`. If the producer crashes before the
   `xadd` completes, the event is silently lost. So the real guarantee is *at-most-once
   producer-side / at-least-once consumer-side* — the worst combination, and it means the
   "at-least-once, handlers must be idempotent" contract documented in `AGENTS.md` is only
   partially true.

4. **`local` vs `stream` transports diverge in semantics.** `EVENT_BUS_MODE=local`
   (in-process `EventEmitter`, `events.ts:314-338`) is what tests and single-process dev run;
   production runs the stream path. They differ in ordering, async behavior, failure handling,
   and backpressure. The stream bus is exercised by exactly one test (`test/events.stream.test.ts`),
   and the *actual wiring* in `worker.main.ts` is never tested end-to-end in stream mode.

5. **The stream is processed serially.** One consumer per process reads entries and `await`s
   every handler before acking (`events.ts:138-147`). A slow handler stalls the entire stream.
   There is no batching, no partitioning, no way to give independent workloads independent
   throughput.

6. **No event schema versioning.** Payloads are bare `{ boardId }` JSON with no envelope,
   version, or producer metadata. Mixed-version deploys (old api + new worker, or vice versa)
   can produce unparseable/undeliverable payloads that end up as poison entries dropped after
   5 attempts (`events.ts:163-168`) — again, silent data loss.

7. **No operational observability.** There is no metric for stream lag, PEL size, entries
   dropped as poison, or reclaim failures. The bus is a black box in the only process (worker)
   that a human cannot otherwise reach. Nothing alerts when it silently degrades.

8. **It reimplements a job-trigger layer that already exists.** Cross-app triggering is exactly
   what BullMQ is for, and `api`/`realtime` already hold the same `jobsRedis` handle the worker
   consumes. The elaborate stream bus exists to preserve "producers must not know which module
   reacts" — a decoupling argument that collapses under the weight of the machinery required to
   maintain it.

**Verdict:** replace the Redis Stream transport with a BullMQ-backed domain-event delivery
layer (Phase 1). This is the highest-value, lowest-risk change in this plan.

### 1.2 Redis-as-source-of-truth for board state is a custom database

`src/modules/collaboration/board-state/` (~1,500 LOC) is a bespoke write-through store:
elements hash + monotonic sequence, capped change-log, dirty-set/dirty-by-age/active indices,
per-element dirty/deleted sets, `dirty_since`/`dirty_epoch`, distributed locks (load, eviction,
mutation), solo/collab write modes, and an epoch-guarded incremental flusher
(`persistence-domain.ts`, 545 lines). Key problems:

1. **Durability is a lie under full Redis loss.** In collab mode, edits sit only in Redis
   (plus the dirty markers that would trigger the flush) until the 30s flush job
   (`background-jobs.ts:39-48`). A lost Redis volume/node loses both the edits *and* the dirty
   markers, so the Postgres mirror is never even told it is stale. AOF (`docker-compose.yml`)
   protects against process crash, not data-loss events (misconfig, FLUSHALL, volume loss).
   There is no backup/restore story for Redis, and no outbox/journal.

2. **Three representations of one concept.** Yjs in-memory doc (moves), Redis hash + change-log
   (hot state), Postgres (durable mirror). Reconciliation between them is the entire
   collaboration module. Each representation has its own failure modes and loss windows.

3. **Hand-rolled consistency primitives.** Distributed mutex with renewal
   (`mutation-lock-domain.ts`), epoch-guarded clears via bespoke Lua (`persistence-domain.ts:354-392`),
   lazily-probed "wait for load" (`load-domain.ts:51-69`). All of this is correct today and
   well-tested, but it is a large, hard-to-reason-about surface that a small team owns forever.

4. **Yjs is used as a convergence relay for one field only** (`crdt-room.ts:40-41` — a
   `Y.Map('moves')`). The actual product data model (elements with server-enforced locks,
   cascade deletes, month-range reconciliation in `lock-enforcement.ts`) is NOT in the CRDT; it
   is hand-synced. So the design pays the complexity cost of Yjs **and** the complexity cost of
   a bespoke element sync layer, and gets the durability benefit of neither.

### 1.3 The API contract is maintained by hand and already drifting

- OpenAPI is generated from a hand-maintained document (`src/shared/openapi/document.ts`, 325
  lines) that covers a subset of endpoints (workspaces, auth callback/refresh/logout, boards
  get/invites/members/link-sharing) while the real surface has substantially more: users,
  board mutations (`PATCH /boards/:id/elements`, `POST /boards/:id/mutations`), preview-jobs,
  active-users, presence, link-sharing rotate, invitations, billing webhooks, Google OAuth
  start. Nothing enforces that a documented route exists or that a live route is documented.
- Validation schemas live per-route (`shared.ts` + `openapi/schemas.ts`); the OpenAPI doc
  re-declares the same shapes separately. Duplication guarantees drift.

### 1.4 Observability is half-built

- Metrics are recorded with **dynamic metric names** and a single `tagset` label that folds
  *all* tags (including `boardId`) into one string (`metrics.ts:46-50,62-100`). That is
  unbounded-cardinality Prometheus output — the comment claims it is "bounded to keep
  cardinality safe," which is wrong; every board id becomes a new `tagset` value.
- No distributed tracing at all, despite a three-process async path (REST/socket → event →
  worker → DB). Request ids propagate through REST (`create-app.ts:56-74`) but not into the
  worker or the bus.
- No gauges for the two things that matter most: **dirty-board backlog** (only exposed in the
  health payload, `openapi/document.ts:25-31`) and **event queue lag / PEL size**.

### 1.5 Security debt

- `ENABLE_OAUTH_FRAGMENT_TOKENS` still defaults to **true** (`config.ts:37`) while the comment
  itself calls the fragment approach deprecated because tokens leak via history. Shipping a
  security hole as the default is indefensible.
- `ENABLE_LEGACY_API_ROUTES` defaults to true (`config.ts:33`, `create-app.ts:184-187`),
  mounting a second, unversioned copy of every product route. That is a permanent extra attack
  surface and a drift hazard.
- Cookie-based access token with no CSRF defense-in-depth (no SameSite analysis documented, no
  Origin check). Bearer+header is fine, but the cookie path needs a documented posture.
- Socket.IO accepts unlimited payload sizes and has no per-socket rate limiting; `MUTATION_BATCH`
  and `CRDT_UPDATE` are unthrottled (`server.ts:291-296`). The REST side has rate limits; the
  realtime side has none.

### 1.6 Realtime and presence overlap

Three parallel membership systems exist: Socket.IO rooms + redis adapter (`server.ts:56`),
the participants store (`participants.ts` — hash + expiry zset, TTL 90s), and the
board-state presence domain (`presence-domain.ts` — clients set + leases, viewer_sessions
zset). They are kept in agreement by orchestration in `server.ts` (heartbeat interval at
`server.ts:95-107`, activity throttle, cleanup-on-empty). Each has its own TTL, expiry and
prune logic. This is three sources of truth for "who is on this board," reconciled manually.

### 1.7 Testing gaps

- No **cross-app** test: nothing boots `api`+`worker` (or `realtime`+`worker`) in
  `EVENT_BUS_MODE=stream` and asserts that a mutation produces a preview job. The riskiest
  wiring in the system (bus → worker → BullMQ) is untested in its production shape.
- No **OpenAPI contract test** (routes vs document).
- No tests for: billing routes, swagger route, metrics route, debug route auth, the
  `tagset` metric exporter, or the outbox/backpressure paths.

### 1.8 Other

- Bull Board is mounted from the **api** process which must open its own handles to worker
  queues (`api.main.ts:23-26`) — cross-app read coupling that Phase 1 can remove.
- The "share one codebase, split at deploy" model ships the whole module graph in every image
  (lazy getters prevent eager cost, but code is still present in every artifact).
- No backup/restore runbooks for Postgres or Redis; `docker-compose.yml` has no backup
  service, and `DEPLOY.md` stops at "schedules survive restarts."

---

## 2. What is NOT the problem (avoid fixing these)

- **Express 5, Zod 4, Drizzle ORM, TypeScript 6, pino, vitest** — already modern.
- The **factory-function DI** style (`createX(...)` with injected deps) — keep it; it is
  testable and clear. Do not introduce a DI framework.
- **Socket.IO vs raw websockets** — Socket.IO is fine and already the client contract.
- The **single-writer mutation lock** and **solo/collab write modes** — correct; do not rewrite
  unless Phase 2's strategic option is chosen.
- **BullMQ for scheduling** — the right tool, and the thing the event bus should have been.

---

## 3. Target architecture (2026, Node + Express)

Principles:

1. **Nothing custom that a library already does well.** Async delivery = BullMQ, not a Redis
   Stream. Tracing = OpenTelemetry, not log forensics. Docs = generated from the same Zod
   schemas that validate, not a hand-maintained file.
2. **Postgres is the only system of record for anything durable.** Redis remains a hot-state
   cache/read-model for board edits, with the durability gap closed by an outbox journal (Phase
   2 decision, gated) — or, at minimum, by documenting and defending the real loss window.
3. **One write path, one read path, one document of truth for the API.**
4. **Everything async is observable**: queue depth, age, lag, PEL, poison, and per-route RED
   metrics with bounded cardinality.
5. **Realtime is hardened like REST**: auth on connect, payload caps, per-socket rate limits.

Target shape (unchanged process topology; changed internals):

```
browser ─ nginx (path split)
   ├─ api        Express REST  (+ typed routes → OpenAPI 3.1 generated from route schemas)
   ├─ realtime   Socket.IO     (auth on connect, throttled, bounded payloads)
   └─ worker     BullMQ        (repeatable persist/cleanup + preview render + domain-event dispatch)

cross-app async: BullMQ queues only
   board-domain-events  (BOARD_MUTATED / BOARD_EDITORS_LEFT → worker dispatch)
   board-preview        (render, debounced + deduped)
   board-persist-flush  (repeatable)
   board-maintenance    (repeatable)

local mode: in-process EventEmitter (tests / single-process dev) — same API, same handlers.
```

---

## 4. Phased implementation plan

Each phase lists **motivation → steps → acceptance criteria**. Phases are independently
shippable. A coding agent should implement one phase, verify (`just build`, `npm run lint`,
`just test`), and stop for review.

### Phase 1 — Replace the Redis Stream event bus with BullMQ-delivered domain events

**Motivation:** Section 1.1. Delete ~280 lines of hand-rolled distributed-systems code; make
cross-app triggers durable, retryable, deduplicated, and observable via the infrastructure
BullMQ already provides.

**Steps:**

1. Add a new queue name in `src/platform/jobs/queues.ts`:
   `domainEvents: 'board-domain-events'`.
2. Add an enqueue helper (mirror `createJobsQueue`): `createDomainEventsQueue(connection)`
   with `defaultJobOptions` like the preview queue (attempts, exponential backoff,
   removeOnComplete/OnFail).
3. Rewrite `src/shared/events.ts` so that `createAppEventBus({ redis })` — where "redis" is
   actually the jobs connection — produces a **BullMQ-backed** `AppEventBus`:
   - `emit(event, payload)` → `queue.add(event, payload, { jobId: <event>-<hash>, ... })`.
     Use BullMQ dedup or deterministic `jobId` + `removeOnComplete` so repeated
     `BOARD_MUTATED` for the same board coalesce, preserving today's debounce behavior.
   - `on(event, handler)` registers in-process handlers against a dispatch function.
   - A worker started by the **worker app** consumes the queue and dispatches each job to the
     registered handlers (fire `handlersByEvent`), mirroring the current fan-out.
   - Delete the stream implementation entirely: reader connection, `xgroup`,
     `xreadgroup`, `xack`, `xautoclaim`, `xinfo` pruning, poison drop, `MAXLEN`. Keep the
     in-process `EventEmitter` implementation unchanged for `local` mode.
4. Update the composition root `src/app/runtime.ts:71-77`: the stream option now constructs
   the BullMQ-backed bus on `jobsRedis` (the same connection worker already uses). Rename
   config `EVENT_BUS_MODE=stream` → keep the env var but treat "stream" as "bullmq";
   deprecate the `streamKey`/`consumerGroup`/reclaim options.
5. Update `src/apps/worker.main.ts:52-61` to start the domain-event consumer and register the
   two preview handlers against it (same two subscriptions, same behavior).
6. Move Bull Board's worker-queue handles out of `api.main.ts:23-26`: api should not open
   handles on worker queues. Mount Bull Board only in the worker's metrics surface, or keep
   read-only handles but document that they are views, not owners.
7. Update `test/events.stream.test.ts` → rename/rework as `test/events.bullmq.test.ts`:
   same three scenarios (delivery, fan-out to multiple handlers, redelivery/retry on handler
   failure) against the BullMQ transport.
8. Add **one cross-app e2e test** (new `test/app.cross-app.test.ts`): boot the API app and the
   worker's job layer in-process with `EVENT_BUS_MODE` set to the BullMQ transport, POST a
   mutation, and assert a `board-preview` job lands in the queue with the right boardId.

**Acceptance criteria:**
- `git grep -n "xreadgroup\|xautoclaim\|xgroup\|streamKey\|APP_EVENTS_STREAM" src/` returns only
  `test/` cleanup references; no stream code remains in `src/`.
- `just test` green (including new e2e). `just build`, `npm run lint` green.
- Both `EVENT_BUS_MODE=local` and the BullMQ transport are exercised by tests.
- Preview triggers behave identically: debounced `enqueue` on `BOARD_MUTATED`, 3s flush
  `enqueueFlush` on `BOARD_EDITORS_LEFT`.
- No behavior change for api/realtime emit sites; they still call `deps.events.emit(...)`.

**Risks:** the queue becomes the single cross-app channel — it must be visible on Bull Board and
monitored (Phase 3). Delivery is now at-least-once with retries; preview enqueue already dedups,
so idempotency holds.

---

### Phase 2 — (Gated) Close the Redis durability gap

**Motivation:** Section 1.2.1. This is the only phase that may change product behavior; it is
gated on a team decision.

**Two options to decide (see Section 6):**

- **Option A — Outbox journal (recommended, additive):** add a `board_event_log` table
  (`boardId`, `seq`), and have the solo-mode write path (`processor.ts:340-382`) insert the
  journal row in the **same Postgres transaction** as the element upserts. The flush job
  reconciles journal entries the same way it reconciles dirty boards, and the domain-event
  emitter is fed from the journal (outbox → queue) rather than from the HTTP/socket handler.
  Result: no edit is ever lost to Redis, and every mutation is eventually observable. Cost: a
  new table + writing the flush reconciliation twice. This turns Redis from "system of record"
  into "hot read-model + write buffer," which is the correct 2026 posture.
- **Option B — Accept and document the window:** leave the store as-is, but (a) add Redis
  backup/restore runbooks and snapshot job, (b) add an alert if dirty backlog > N, (c) state
  the loss window explicitly in `DEPLOY.md`. Cheapest, honest, but leaves the architectural
  debt.

**Steps (if Option A):**
1. Drizzle migration: `board_event_log(board_id uuid, seq bigint, payload jsonb, created_at,
   PRIMARY KEY(board_id, seq))`.
2. In `persistence-domain.ts` incremental path, wrap the element upsert/delete tx and a journal
   insert in one transaction.
3. New repeatable job `dispatch-domain-events` (or fold into the persist flush worker): reads
   journal rows, publishes them to the Phase 1 queue with dedup, deletes acked rows
   (outbox relay).
4. Update `BOARD_MUTATED`/`BOARD_EDITORS_LEFT` producers: REST/socket handlers emit through
   the journal path instead of directly, or keep direct emit for `BOARD_EDITORS_LEFT` (a
   Redis-only signal is acceptable — it self-heals).
5. Tests: crash/replay simulation — kill the process between Redis write and Postgres write,
   assert no data loss after restart.

**Acceptance criteria (Option A):** `board_event_log` exists and grows only transiently; a
kill-between-writes test proves replay; `just test` green.

**Risks:** writing two stores doubles the flush path surface; keep the journal schema minimal
and the relay dumb.

---

### Phase 3 — Observability: OTel tracing, metric hygiene, alerting

**Motivation:** Section 1.4.

**Steps:**
1. Add `@opentelemetry/sdk-node` + instrumentations (`@opentelemetry/instrumentation-http`,
   `express`, `pg`, `redis`/ioredis, `bullmq` if available, `socket.io` if available).
   Initialize once in `src/apps/*.main.ts` before the runtime is created; export via OTLP when
   `OTEL_EXPORTER_OTLP_ENDPOINT` is set, no-op otherwise (zero prod cost until enabled).
   Preserve `x-request-id` → `traceparent` mapping so REST/socket logs link to traces.
2. **Fix metric cardinality** in `src/platform/observability/metrics.ts`: stop folding tags into
   a single `tagset` string. Use fixed, pre-registered Prometheus metrics with static label
   names. Board-id is never a label; aggregate board-level metrics by board when needed and
   keep cardinality bounded (e.g., only boards in the top-N).
3. Add gauges (as fixed-label metrics):
   - `board_dirty_backlog` (from `boards:dirty` set size — already read by health).
   - `domain_events_queue_depth`, `domain_events_queue_oldest_age` (BullMQ `getMetrics` /
     `getJobCounts`), PEL size where applicable.
   - `preview_queue_depth`, `preview_job_latency_seconds` (histogram).
   - Socket.IO: open connections, rooms, messages per second (currently only open connection
     counters in `stats.ts`).
4. Expose these from all three HTTP surfaces (`api.main.ts`, `realtime.main.ts`,
   `worker.main.ts` metrics routes already exist).
5. Add alerting rules (Prometheus/alertmanager or the platform's equivalent) for:
   dirty backlog > threshold; domain-events queue age > 5m; preview queue age > 10m;
   error ratio > 1% per route.

**Acceptance criteria:** `/metrics` on all three apps shows bounded-cardinality fixed-label
metrics; with `OTEL_EXPORTER_OTLP_ENDPOINT` set, a local OTel collector receives spans covering
a REST mutation → event → worker → DB; `just test` green.

**Risks:** OTel adds runtime cost only when enabled; keep default disabled. Avoid
over-instrumenting hot paths (mutation lock polling) — sample or drop those spans.

---

### Phase 4 — Realtime hardening and presence consolidation

**Motivation:** Section 1.5 (no socket throttling/payload caps) and 1.6 (three presence stores).

**Steps:**
1. **Auth on connect:** run the token verification in the Socket.IO `connection` middleware
   (from `identity.ts:21-29`) so anonymous sockets are the *exception* declared explicitly,
   not the default. Keep the existing join-time access check.
2. **Payload bounds:** cap incoming `MUTATION_BATCH`, `CRDT_UPDATE`, and `REALTIME_TICK`
   payload sizes (byte/op-count limits) in the payload parsers (`payloads.ts`) and reject
   oversized frames with `SYNC_ERROR`. Add an explicit max buffer size / max ops-per-100ms per
   socket (a simple token bucket in `server.ts` next to `refreshSocketActivity`).
3. **Presence consolidation:** pick one store. Recommended: keep the **participants store**
   (already cross-replica, TTL-based, Lua-pruned) and delete the overlap in
   `presence-domain.ts` (clients set + lease keys and viewer_sessions zset) OR vice versa.
   Whichever survives, ensure collab-mode detection (`getSyncWriteMode`,
   `presence-domain.ts:127-149`) and `getActiveViewerCount` read from it. This is a careful
   refactor with the `socketio.server.test.ts` and `participants.test.ts` suites as the guard.
4. Keep the heartbeat and activity-throttle logic as-is (they are correct); just retarget them
   at the surviving store.

**Acceptance criteria:** oversized/rapid frames are rejected with `SYNC_ERROR`; a socket that
fails auth cannot join; one presence store is used everywhere (no shared keys for the removed
stores); `just test` green.

**Risks:** presence consolidation is the subtlest refactor in the plan — do it in small commits
and keep both stores readable until tests pass. Do not touch write-mode selection semantics.

---

### Phase 5 — Security debt cleanup

**Motivation:** Section 1.5.

**Steps:**
1. Flip `ENABLE_OAUTH_FRAGMENT_TOKENS` default to `false` (`config.ts:37`) and, in the same
   release, add a smoke test that the callback never puts tokens in a fragment.
   Coordinate the frontend flip first.
2. Flip `ENABLE_LEGACY_API_ROUTES` default to `false` (`config.ts:33`), verify the frontend
   speaks `/api/v1` only, then remove the flag and the legacy mount (`create-app.ts:184-187`).
3. Cookie posture: add `SameSite=Lax` (or `Strict`) + `__Host-` prefix to the auth cookies
   (set in `session.routes.ts` / `google.routes.ts`), and add an Origin header check on
   cookie-authenticated state-changing routes as CSRF defense-in-depth.
4. Harden JWT: confirm `algorithm: HS256` pinning is enforced in `verifyAccessToken`
   (`auth.service.ts`) — the commit history mentions alg pinning; add a test that an `alg: none`
   or `HS256`-signed-with-RS-key token is rejected.

**Acceptance criteria:** defaults flipped and documented in `.env.example`; CSRF checks active
for cookie-authenticated POST/PATCH/DELETE; JWT alg tests exist; `just test` green.

**Risks:** these are breaking changes for any client relying on legacy routes or fragment
tokens — coordinate with the frontend before merging.

---

### Phase 6 — API single-source-of-truth + contract tests

**Motivation:** Section 1.3.

**Steps:**
1. Introduce a tiny typed-route helper (`src/shared/route.ts`, Express-native):
   `defineRoute({ method, path, request: { params?, query?, body? }, response, handler })`
   that (a) validates with the given Zod schemas, (b) registers on the router, (c) records the
   operation into an in-memory registry with a `zod-openapi` compatible schema.
2. Migrate routes incrementally, one module at a time, in this order: auth → users →
   workspaces → boards (access, management, members, invitations, link-sharing, mutations) →
   billing → previews. Keep existing handlers; only move validation + registration.
3. Replace the hand-written `src/shared/openapi/document.ts` with a generator that walks the
   registry (drop the duplicated path declarations). Delete `openapi/schemas.ts` drift by
   generating from the route schemas.
4. Add a **contract test** (`test/openapi.contract.test.ts`): boot `createApp`, walk the
   Express router stack, and assert every mounted product route appears in the generated
   OpenAPI document and vice versa. Fail CI on drift.
5. Add a **typed client test**: the OpenAPI doc must render a TypeScript client that
   type-checks against `@asteasolutions/zod-to-openapi` output (optional if too much tooling —
   the contract test is the required part).

**Acceptance criteria:** `test/openapi.contract.test.ts` passes; no hand-maintained paths list
remains; swagger renders the full surface; all 400-path schemas documented; `just test` green.

**Risks:** broad refactor touching every route. Keep each route's behavior byte-identical;
migrate module-by-module so each lands green. This is the largest-effort phase — if the team
ships Phases 1, 3, 4, 5 first, the value is preserved without it.

---

### Phase 7 — Ops: backups, replicas, deploy modernization

**Motivation:** Section 1.8; Section 1.2.1 (no Redis backup).

**Steps:**
1. **Postgres backup/restore runbook** + a `backup` compose profile (`pg_dump`/`pg_restore`
   scripts in `scripts/`), exercised in CI (restore the dump into a throwaway DB and assert
   row counts).
2. **Redis backup:** `BGSAVE` snapshot job + runbook for restoring `redis-realtime` (the
   durability gap from Phase 2 Option B is mitigated by the snapshot + outbox if Option A).
3. **Read replicas (optional, gated):** point preview rendering reads (`preview-job.service.ts:167-174`,
   billing/list reads) at a read replica via a second pool in `createDb`. Only if load warrants.
4. **Valkey/Redis 7.x upgrade note:** verify `ioredis` compatibility; document sentinel/cluster
   topology if >1 Redis node is ever needed.
5. **Image slimming:** ensure each app image is built with only its app's code reachable (the
   lazy runtime already prevents eager cost; consider a `--filter` on bundling later). Low
   priority.

**Acceptance criteria:** `scripts/` contains working backup/restore scripts with CI validation;
runbooks linked from `DEPLOY.md`; `just test` green.

**Risks:** read replicas add replication-lag subtleties (preview reads may be momentarily
stale — acceptable for previews). Gate behind the Phase 2 decision.

---

## 5. Adverse review of this plan

A plan that cannot survive its own criticism is not a plan. Issues:

1. **Phase 1 trades a silent-loss stream for a queue that is also silently lossy under total
   Redis loss** — BullMQ's persisted jobs live in Redis too. The plan fixes the *mechanism*
   (delivery, retry, dedup, observability) but not the *durability* of the trigger itself.
   That is why Phase 2 (outbox) exists — but Phase 2 is gated and may be declined, in which
   case Phase 1's improvement is entirely about operational sanity, not data safety. The plan
   must be read as: Phase 1 buys observability + simplicity; only Phase 2 buys durability.
   If the team wants durability first, Phase 2's journal should move ahead of Phase 1.

2. **Phase 2 Option A is the "real" fix and it is expensive.** Writing every mutation to a
   Postgres journal from the solo-mode write path changes the hottest write path in the
   system and doubles the reconciliation surface. There is a real risk the coding agent
   introduces a regression in the epoch-guarded flush. It is gated for a reason — but gating
   it means the plan's headline promise ("no data loss") is conditional.

3. **Phase 6 is the largest and least critical.** Rewriting every route into a typed-route
   helper for contract-tested docs is a lot of churn for an internal API whose main consumer
   is one frontend. The adverse take: it may not be worth doing at all if the team accepts
   OpenAPI drift. The plan should be read with Phase 6 marked *optional / effort-gated*.

4. **The plan is biased toward "keep and harden" rather than "re-architect."** The genuinely
   modern 2026 answer to a collaborative editor is a Yjs document store persisted by a real
   provider (e.g., y-sweet / y-redis / sync protocol), with server rules layered on top — and
   the whole bespoke element-store/change-log/solo-collab/epoch-guard stack retired. This plan
   keeps that stack because it is working, tested, and the product rules (locks, cascades,
   month-range reconciliation) do not map cleanly onto free-form Yjs. A reviewer could fairly
   call this plan "polish" rather than "modernization." The honest framing: this plan removes
   the *avoidable* complexity (bus), hardens the *defensible* complexity (board store), and
   leaves the *strategic* rewrite (Yjs-native persistence) for a dedicated spike — which the
   plan should recommend explicitly as a follow-up.

5. **Phase ordering leaves transitional states.** Between Phase 1 and Phase 2, events are
   BullMQ-delivered but still emitted fire-and-forget from handlers. Between Phases 1–7 the
   system is always shippable (each phase is independent) — but a coding agent implementing
   straight through without team checkpoints could compound small mistakes across phases.
   The plan presumes review gates between phases; if none are held, the risk compounds.

6. **Presence consolidation (Phase 4.3) is the subtlest step and is underspecified.** It can
   change collab-mode detection timing, which changes persistence behavior. It needs its own
   detailed design and the collab-mode tests as a hard gate. It may deserve to be its own
   phase with a spike.

7. **Observability work presupposes an OTel collector / Prometheus exist.** If the team has no
   monitoring stack at all, Phase 3's alerting steps have no target. The plan should be
   scoped to "emit correct telemetry; leave collector wiring to ops."

8. **The plan adds no feature flag or rollout plan for the breaking security flips (Phase 5).**
   Flipping fragment-token and legacy-route defaults can break a live frontend. It should
   explicitly sequence the frontend deploy first.

9. **Scope:** seven phases is a lot for one agent. If the goal is a single focused change,
   **Phase 1 alone is the highest-leverage work and is fully deliverable.** Phases 3–7 are a
   roadmap, not a batch.

**Net assessment:** the plan is sound on the *avoidable* complexity (kill the custom bus) and
honest about the *strategic* rewrite it is not doing. It is over-scoped if treated as one unit;
treat Phases 1 + 3 as the core deliverable, Phase 2 as a gated decision, and Phases 4–7 as a
backlog to pick up in order.

---

## 6. Decision points for the team

1. **Phase 2:** Option A (outbox journal — durable, more work) vs Option B (accept + document +
   back up Redis). *Recommend A if uptime/durability is a product promise; B if this is a
   hobby/small scale.*
2. **Phase 6:** is contract-tested OpenAPI worth a full route refactor? *Recommend: do the
   contract test + generator now, migrate routes opportunistically.*
3. **Phase 3:** is there (or will there be) an OTel collector / Prometheus to point at?
   *If not, do the metric-hygiene fixes and skip tracing.*
4. **Strategic follow-up:** should we spike "Yjs as the persisted document store" as a
   separate initiative? *Recommend yes, timeboxed, with the current store kept as fallback.*
5. **Review gates:** will each phase be reviewed before the next starts?

---

## 7. Suggested commit/PR sequence for the implementing agent

1. Phase 1 → PR "replace Redis Stream event bus with BullMQ domain-event queue" (+ new e2e).
2. Phase 3 metric hygiene + gauges → PR "bounded-cardinality metrics + queue gauges".
3. Phase 5 → PR "security defaults: fragment tokens off, legacy routes off, CSRF, JWT alg tests".
4. Phase 4 → PRs "socket auth/payload caps" then "presence consolidation".
5. Phase 6 → PRs per module: "typed routes: auth", "… users", etc., then "generate OpenAPI from registry + contract test".
6. Phase 2 (if A) → PR "board event journal + outbox relay".
7. Phase 7 → PR "backup/restore scripts + runbooks".

Each PR must keep `just build`, `npm run lint`, `just test` green, and must not change
wire-protocol names (`src/modules/realtime/socketio/constants.ts`).
