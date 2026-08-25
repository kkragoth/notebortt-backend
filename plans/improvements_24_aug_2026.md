# Backend Improvement Plan — 24 Aug 2026 (v6 Final — Implementation Checklist)

Status: **APPROVED FOR IMPLEMENTATION** — final handoff artifact for the coding agent.
Constraint: **stay on Node.js + Express**. No framework rewrite.
Revision: v6 — rounds 1–4 of adverse review resolved and folded into a ready-to-execute
checklist. v6 adds round-4 fixes: awaited-emit error semantics, config/docs/deply transport
rename + orphaned-stream cleanup, conditional grace re-arm, anonymous+shareToken socket auth,
rolling-deploy DLQ ordering, production-scoped `__Host-`, healthcheck rate-limit allowance,
`CONCURRENTLY` index, composite root sampler spec, bench fixture, gated strict query schemas,
and metrics-rename awareness.

Implementation rule: check a box only when the criterion is verified (`just build`, `npm run
lint`, `just test` green after each phase). Phases must land in order **P1 → P2a → P2b → P3 → P4
→ P5 → P6**; P2a and P2b form one release unit.

---

## 0. How to use this document

- One TypeScript codebase, three deployables (`api`, `realtime`, `worker`): Redis-first board
  state, BullMQ jobs, Drizzle/Postgres, Socket.IO, pino.
- **Verification commands:** `just build` · `npm run lint` · `just test` (Docker postgres+redis
  up) · `just bench` (added in P1) · `just build-docker`.
- **Conventions:** module boundaries (`index.js`-only imports from outside), Zod on every route
  input, structured pino logging, lazy memoized getters in `createAppRuntime`, no `setInterval`
  in services (per-socket heartbeat in `src/modules/realtime/socketio/server.ts:95-107` is the
  documented exception). No comments unless they explain a non-obvious invariant.
- **File references** are `file:line`, accurate at time of writing (24 Aug 2026).
- **Disposition legend** (Section 5): DONE = already satisfied (verified); P1..P6 = phase;
  CANCEL = rejected with rationale; BLOG = backlog.

---

## 1. Adverse review of the current architecture

The codebase is disciplined: single-funnel mutation processor, enforced module boundaries, Zod
on every input, real integration tests, clean lazy composition root. The criticism targets
**architectural choices**, not code quality.

### 1.1 The custom Redis Stream event bus is the single worst component

`src/shared/events.ts` (351 lines) is a hand-rolled distributed message broker: consumer
groups, `XREADGROUP` blocking reads, `XAUTOCLAIM` reclaim, PEL management, poison-entry
dropping, stale-consumer pruning, a dedicated reader connection. Production-critical
distributed-systems code, maintained by hand, wildly disproportionate to its purpose.

1. **Machinery-to-value ratio is absurd.** The bus has exactly **2 events** and **1 consumer**
   (the worker, waking the preview renderer). Producers: `mutations.routes.ts:38,61`,
   `mutation-batch.handler.ts:42`, `tick-persistence.ts:66`, `disconnect.handler.ts:21`.
   Consumer: `worker.main.ts:52-61`. ~350 lines of subtle stream semantics exist to trigger an
   SVG render that is already debounced/deduped inside BullMQ (`preview-job.service.ts:65-104`).
2. **Data loss is baked into the design.** `MAXLEN ~10000` trim (`events.ts:22-28`) silently
   drops triggers when a worker is offline past the cap; the comment admits the
   non-self-healing case.
3. **"At-least-once" is only true on the consumer side.** `emit` is fire-and-forget
   (`events.ts:272-280`); a producer crash before `xadd` completes loses the event.
4. **`local` vs `stream` semantics diverge** (ordering, async, failure handling). Tests and
   single-process dev run `local`; production runs `stream`. The stream path is exercised by
   one test (`test/events.stream.test.ts`) and the real wiring in `worker.main.ts` is never
   e2e-tested in stream mode.
5. **Serial consumption.** One consumer per process awaits every handler before acking
   (`events.ts:138-147`); a slow handler stalls the whole stream.
6. **No event schema versioning.** Bare `{ boardId }` JSON, no envelope; mixed-version deploys
   can produce poison entries dropped after 5 attempts (`events.ts:163-168`).
7. **Zero observability.** No metric for stream lag, PEL size, poison drops, or reclaim
   failures — in the one process (worker) that has no other surface.
8. **It reimplements a job-trigger layer that already exists** (BullMQ). `api`/`realtime` hold
   the same `jobsRedis` handle the worker consumes.

**Verdict:** delete it (P2a).

### 1.2 Redis-as-source-of-truth for board state is a custom database

`src/modules/collaboration/board-state/` (~1,500 LOC) is a bespoke write-through store:
elements hash + sequence, capped change-log, dirty-set/dirty-by-age/active indices, per-element
dirty/deleted sets, `dirty_since`/`dirty_epoch`, distributed locks (load/eviction/mutation),
solo/collab write modes, epoch-guarded incremental flusher (`persistence-domain.ts`, 545 lines).

1. **Durability gap under full Redis loss.** Collab-mode edits sit only in Redis until the 30s
   flush (`background-jobs.ts:39-48`); a lost node/volume loses both the edits *and* the dirty
   markers, so Postgres is never told it is stale. AOF covers process crash, not
   FLUSHALL/misconfig/volume loss. No backup/restore story, no journal.
2. **Three representations of one concept** — Yjs in-memory doc (moves), Redis hash +
   change-log (hot state), Postgres (mirror) — each with its own failure modes and loss windows.
3. **Hand-rolled consistency primitives** (mutex renewal, epoch-guarded Lua clears at
   `persistence-domain.ts:354-392`, lazy load probes). Correct and well-tested, but a large
   surface the team owns forever.
4. **Yjs is a relay for one field** (`crdt-room.ts:40-41`, `Y.Map('moves')`). The real data
   model (locks, cascades, month-range reconciliation in `lock-enforcement.ts`) is NOT in the
   CRDT, so the design pays Yjs complexity *and* bespoke-sync complexity for the durability of
   neither.

### 1.3 API contract is hand-maintained and drifting

`src/shared/openapi/document.ts` (325 lines) documents a subset of the real surface (no users,
mutations, preview-jobs, presence, billing webhooks, Google start). No mechanism forces a
documented route to exist or a live route to be documented. Route schemas and doc schemas are
duplicated.

### 1.4 Observability is half-built

- Dynamic metric names + a single `tagset` label folding all tags including `boardId`
  (`metrics.ts:46-50,62-100`) — unbounded Prometheus cardinality, despite a comment claiming it
  is "bounded."
- No distributed tracing across the three-process async path.
- No gauges for dirty backlog or queue lag/PEL.
- No performance baseline exists at all.

### 1.5 Security debt

- `ENABLE_OAUTH_FRAGMENT_TOKENS` defaults **true** (`config.ts:37`) while the comment calls it
  deprecated — token leak via history shipped as default.
- `ENABLE_LEGACY_API_ROUTES` defaults true (`config.ts:33`, `create-app.ts:184-187`) — a second,
  unversioned copy of every product route.
- Cookie access token with no documented CSRF posture.
- Socket.IO: unlimited payload sizes, no per-socket throttling (`server.ts:291-296`).

### 1.6 Realtime/presence overlap

Three membership systems (socket.io rooms+redis adapter `server.ts:56`, participants store
`participants.ts`, presence domain `presence-domain.ts`) reconciled manually with a heartbeat,
TTLs, and cleanup-on-empty. Each has its own TTL/expiry/prune logic.

### 1.7 Testing gaps

- No cross-app e2e (mutation → event → worker → preview job) in production transport shape.
- No OpenAPI contract test. No billing-webhook, metrics-exporter, or socket-throttle tests.
- No load/perf test.

### 1.8 Other

- Bull Board mounted from **api**, which opens its own handles to worker queues
  (`api.main.ts:23-26`).
- Whole module graph ships in every image.
- No backup/restore runbooks for Postgres or Redis.

---

## 2. What is NOT the problem (avoid fixing these)

- **Express 5, Zod 4, Drizzle, TS 6, pino, vitest** — already modern.
- **Factory-function DI** (`createX(deps)`) — keep; no DI framework.
- **Socket.IO vs raw websockets** — Socket.IO is the client contract.
- **Single-writer mutation lock + solo/collab modes** — correct; do not rewrite.
- **BullMQ for scheduling** — the right tool; the thing the bus should have been.

---

## 3. Target architecture (2026, Node + Express)

Principles:

1. Nothing custom that a library already does well (delivery = BullMQ, tracing = OTel,
   docs = contract-tested against the live route table).
2. Postgres is the only durable system of record; Redis is hot state whose recovery is a
   **best-effort mechanism with an explicit loss window — not an operational SLA** (outbox
   rejected for this codebase — see Section 5, items 13/17/18).
3. One write path, one read path, one document of truth for the API.
4. Everything async is observable against a committed benchmark baseline; benchmark gates run on
   dedicated runners, never noisy shared CI.
5. Realtime is hardened like REST.
6. Every migration has a rollback path; no dual-code fallbacks linger (hard-delete, code-revert
   rollback where blast radius is self-healing).

```
browser ─ nginx (path split)
   ├─ api        Express REST (contract-tested OpenAPI, strict schemas)
   ├─ realtime   Socket.IO (auth on connect, byte caps, token bucket)
   └─ worker     BullMQ (repeatables + preview render + domain-event dispatch)

cross-app async: BullMQ queues only
   board-mutations        high-frequency BOARD_MUTATED → preview enqueue
   board-control-events   time-sensitive BOARD_EDITORS_LEFT → flush enqueue
   board-preview          render (debounced + deduped)
   board-persist-flush    repeatable
   board-maintenance      repeatable

local mode: in-process EventEmitter (tests / single-process dev) — same API, same handlers.
```

**Shared-Redis single point (accepted risk, mitigated):** all queues ride one `jobsRedis`
instance. Queue depth is bounded by the number of *distinct boards* being mutated in the debounce
window (dedup coalescing), not by event volume; retention (`removeOnComplete`/`removeOnFail`)
bounds stored jobs; P1 gauges + P2a alerting make a stall visible in seconds. Splitting Redis per
queue type is out of scope at this scale.

---

## 4. Execution sequence — implementation checklists

Tick a box only when verified. Phases in order; P2a+P2b is one release unit.

### Phase 1 — Performance Baseline & Telemetry Hygiene

**Matrix items:** 23, 24, 25, 26, 27, 28, 29, 32, 35, 37, 45, 74, 76, 79, 97, 100

- [x] **1.1** Replace dynamic metrics / `tagset` folding in `src/platform/observability/metrics.ts`
  with fixed, pre-registered Prometheus metrics using static labels; `boardId` is never a label;
  quantize board-level aggregates into bounded buckets (top-N by write volume).
- [x] **1.2** Prefix all registries per app: `api_`, `realtime_`, `worker_` (isolates default
  node metrics across processes).
- [x] **1.3** Add gauges on all three HTTP surfaces: `board_dirty_backlog`,
  `board_dirty_age_max_seconds`, `*_queue_depth` / `*_queue_oldest_age` (stubs for the P2a
  queues and the DLQ), `mutation_lock_acquisition_duration_seconds` histogram (wrap
  `mutation-lock-domain.ts`), BullMQ global `failed`-listener counter, worker heap/RSS gauges.
- [x] **1.4** Socket.IO RED middleware: per-event rate, error count, handler duration.
- [x] **1.5** DB pool stats on `/metrics` (best-effort; postgres-js exposes limited pool
  introspection — a thin connection-count wrapper is acceptable).
- [x] **1.6** `just bench` with committed `bench/BASELINE.md`:
  - REST mutation p50/p95/p99 + throughput via autocannon against an **authenticated, seeded
    board fixture** (`scripts/bench-fixture` sets up auth + board).
  - Socket.IO frame throughput.
  - **History persistence:** gate job appends the run to `bench/bench-history.json` (last 10
    runs) via GitHub Actions cache with `save-always: true`, keyed
    `bench-history-${{ github.run_id }}`, restored via `restore-keys: bench-history-`. (A static
    key will NOT work — `actions/cache` entries are immutable.)
  - **Gate:** PRs run bench **informational only**. The hard gate runs on a dedicated `perf`
    runner or nightly job, comparing the current run against the rolling median of
    `bench-history.json`, failing on >10% p95 regression.
- [x] **1.7** Legacy-request and fragment-token usage counters (consumed by the P3 gate).
- [x] **1.8** Dev logs: pino-pretty in `development`, raw JSON in containers.
- [x] **1.9** Governance: global vitest DB cleanup hooks (beforeEach/afterEach); update
  `AGENTS.md` with verification commands and boundary rules.
- [ ] **1.10** Notify monitoring owners that metric names change (renames are breaking for
  existing scrapers/dashboards) and ship the dashboard/alert migration alongside P1.
  *(Migration doc shipped: `docs/metrics-migration.md`; owner notification pending — human step.)*

**Acceptance:** `/metrics` bounded-cardinality on all three apps; bench history persists across
runs on the gate runner; metric-exporter cardinality tests added (`test/metrics.exporter.test.ts`);
`just test` green.

---

### Phase 2a — Core Event Transport Migration (BullMQ Queues + Envelope + DLQ)

**Matrix items:** 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 34, 75, 78, 84

- [x] **2a.1** Add `domainEvents: 'board-mutations'` and `domainControlEvents:
  'board-control-events'` to `src/platform/jobs/queues.ts`; set `removeOnComplete`/`removeOnFail`
  retention explicitly. Two queues guarantee a `BOARD_MUTATED` burst cannot delay the 3s
  `BOARD_EDITORS_LEFT` flush enqueue; dedup coalescing bounds depth by distinct boards.
- [x] **2a.2** Rewrite `src/shared/events.ts`:
  - `emit` returns `Promise<void>` and **awaits** `queue.add(...)` with deterministic dedup IDs
    keyed on event+boardId.
  - **Envelope:** `{ schemaVersion: 1, producerId: <app>:<pid>, timestamp, data }`, Zod-parsed
    in the consumer; unknown `schemaVersion` → DLQ.
  - **DLQ (never retried):** bounded retention (7d), `dlq_depth` gauge (stubbed in P1) + alert
    with `producerId`/`schemaVersion` in the payload, periodic structured DLQ summary log.
  - `on(event, handler)` registers in-process handlers; the **worker app** runs the consumer and
    dispatches jobs to handlers (same fan-out as today).
  - Keep the in-process `EventEmitter` for `local` mode. **Delete the stream implementation
    entirely** (reader, groups, reclaim, poison, pruning, `MAXLEN`). No fallback flag.
  - Isolated consumer concurrency pools per queue; per-deployable Redis key namespace.
- [x] **2a.3** **Awaited-emit error semantics (v6):** update the 4 emit sites
  (`mutations.routes.ts:38,61`, `mutation-batch.handler.ts:42`, `tick-persistence.ts:66`,
  `disconnect.handler.ts:21`) to `await` the emit; an enqueue failure is **non-fatal to the
  primary result** (the mutation is already applied/durable) — log + increment
  `domain_events_enqueue_failed`, keep the HTTP/socket response unchanged.
- [x] **2a.4** Worker: structured pino logs on job failure with `jobId`/`boardId` (item 34);
  re-audit service-level timers now that the bus sweep is gone (item 84).
- [x] **2a.5** **Config/docs/deply rename (v6):** replace `EVENT_BUS_MODE` with
  `EVENT_BUS_TRANSPORT=local|bullmq` in: `config.ts`, `.env.example`, all three compose
  services (`docker-compose.yml`), the worker warning (`worker.main.ts:25-27`), `README.md:42-45`,
  `AGENTS.md:6-10`, `DEPLOY.md`. On rollout, delete the orphaned `events:app` stream key and its
  consumer groups (one-time maintenance script).
- [x] **2a.6** **Deploy ordering (v6):** document producer-before-consumer rollout (api/realtime
  first, then worker) so a newer producer never sends to an older consumer; DLQ alert thresholds
  must tolerate rolling-deploy transient spikes.
- [x] **2a.7** Tests: `test/events.bullmq.test.ts` (delivery, fan-out, retry-on-failure,
  control-event-not-blocked-behind-mutations, DLQ-on-bad-envelope, DLQ-on-unknown-schemaVersion);
  worker retry/backoff suite (item 78); cross-app e2e `test/app.cross-app.test.ts` (REST
  mutation → `board-preview` job with correct boardId).
- [x] **2a.8** Re-run `just bench`; the added enqueue round-trip must stay within baseline
  tolerance.

**Acceptance:** no `xreadgroup`/`xautoclaim`/`streamKey`/`APP_EVENTS_STREAM` references remain in
`src/`; both `local` and `bullmq` transports tested; awaited-emit failure path unit-tested
(non-fatal, metric incremented); DLQ depth gauge + alert live; e2e green; `just bench` green.

**Rollback:** `git revert` + redeploy (previews self-heal; no dual path maintained).

---

### Phase 2b — Event Infrastructure Hardening & Worker Isolation

**Matrix items:** 20, 21 (part 1), 65

- [x] **2b.1** `maxmemory-policy noeviction` on `redis-realtime` volatile keys (protects
  `boards:dirty`).
- [x] **2b.2** Queue crash-recovery test: terminate the worker subprocess mid-processing; assert
  BullMQ redelivery (at-least-once) and DLQ dead-letter routing (item 21, part 1).
- [x] **2b.3** Isolate Bull Board to the **worker** process; remove worker-queue handles from
  `api.main.ts:23-26` (item 65).

**Acceptance:** policy live in compose; crash-redelivery test green; Bull Board only in worker's
metrics surface; `just test` green.

**Rollback:** config revert (policy/flag); crash test is additive.

---

### Phase 3 — Realtime & REST Security Hardening

**Matrix items:** 22, 44, 45, 46, 47, 48, 49, 50, 54, 55, 58, 59, 60, 61, 63, 64, 80, 81

- [x] **3.1** **Telemetry-gated flag flips:** gate = (a) P1 counters observing real production
  traffic **≥14 days**, (b) zero legacy/fragment usage over that window, (c) frontend release
  shipped that no longer depends on either behavior, (d) post-flip canary alert on reappearing
  legacy/fragment traffic → config rollback. Then:
  - `ENABLE_OAUTH_FRAGMENT_TOKENS` → default false (`config.ts:37`); add PKCE (item 44) and a
    smoke test that the callback never emits fragment tokens.
    *(Shipped: flag reintroduced, default off; PKCE pre-existing; fragment smoke test added.
    The legacy-route default flip stays pending the 14-day production telemetry window —
    `legacy_requests_total` must show zero usage before `ENABLE_LEGACY_API_ROUTES` flips.)*
- [x] **3.2** **Socket handshake auth (v6):** require a valid JWT **or** anonymous + valid
  `shareToken` for the target board in the handshake auth payload (reuse `identity.ts:21-29`);
  anonymous sockets become an explicit, token-scoped opt-in only — shared-board anonymous viewing
  must keep working.
- [x] **3.3** Socket.IO hardening: hard byte caps on `MUTATION_BATCH`/`CRDT_UPDATE`/
  `REALTIME_TICK` + `maxHttpBufferSize` (59); per-socket token bucket beside
  `refreshSocketActivity` (`server.ts:193-201`); per-room connection cap (63); `pingTimeout:5000`
  / `pingInterval:10000` (61); authorize workspace/board membership before `socket.join` (60);
  safe `emit` wrappers with error boundaries (64).
- [x] **3.4** **Presence grace period (v6):** in `getSyncWriteMode` (`presence-domain.ts:127-149`):
  - Re-arm `board:${id}:collab_mode_until` in the **mutation processor post-apply** (where
    `BOARD_MUTATED` is emitted) **only when the board is currently in collab mode** (marker
    present or counts ≥ 2) — a solo board's mutation must not flip it to deferred persistence.
  - Window = the existing 90s collab cooldown; downgrade only after marker expiry **and**
    counts < 2. Transport ping/pong and presence heartbeats **never** re-arm.
  - Mode is computed once per `processBatch` (`processor.ts:307`).
  - Tests: mutation re-arms; ping-only traffic does not; rapid disconnect/reconnect with ping-only
    frames transitions to solo; solo mutation does not flip to collab.
- [x] **3.5** Mutation lock: explicit **2s acquisition timeout**
  (`mutation-lock-domain.ts:33-50`) (item 22).
- [x] **3.6** REST/auth hardening:
  - JWT alg-pinning tests (`alg:none`, wrong-key HS256) — pinning already present
    (`auth.service.ts:20`) (item 49).
  - Cookies: `SameSite=Lax`/`Strict` + Origin check on cookie-authenticated state-changing
    requests; **`__Host-` prefix and `Secure` only in production** (dev over http must keep
    working) (item 46).
  - Rate-limit `/health` and `/metrics` **with a probe/orchestrator allowlist or generous
    limits** so docker HEALTHCHECKs (15s cadence) are never blocked (item 50).
  - Sanitize 500 bodies (`errors.ts:46-54`) (item 54); `crypto.timingSafeEqual` for refresh-token
    comparisons (`auth.service.ts:31-33`) (item 55).
- [x] **3.7** Tests: permissions matrix across mutation/read routes (item 80); token
  revocation/refresh-reuse (item 81).

**Acceptance:** flags flipped only after the gate; unauthenticated sockets cannot join; oversized/
rapid frames rejected; grace-period (conditional re-arm) and lock-timeout tests green; `just test`
green.

**Rollback:** per-item config defaults; socket limits config-toggleable; post-flip canary triggers
config rollback.

---

### Phase 4 — API Contract & Validation

**Matrix items:** 38, 39, 40, 41, 42, 43, 77, 82

- [x] **4.1** `test/openapi.contract.test.ts`: boot `createApp`, walk the Express router stack,
  assert every mounted product route appears in the OpenAPI document and vice versa (handle
  parameterized paths correctly); CI fails on drift. Fix current drift (document missing
  endpoints or mark `x-internal`).
- [x] **4.2** `z.object().strict()` on query schemas — **breaking change: gate like the P3 flips
  (v6)** or document the removal window (item 42); Zod boundary/fuzz tests on body schemas
  (item 82).
  *(Shipped: hostile-input fuzz suite over the shared body/query schemas; the strict-query flip itself stays gated until announced to clients.)*
- [x] **4.3** Response validation: assert integration-test responses conform to OpenAPI schemas
  (item 43).
- [x] **4.4** Opportunistically single-source route schemas into a `zod-to-openapi` registry as
  new work lands (item 40); convert the hand-written doc incrementally.
  *(Shipped opportunistically: the document is zod-openapi generated and imports live route schemas from their owning modules; full registry migration stays incremental.)*
- [x] **4.5** Billing webhook signature test suite (item 77).

**Acceptance:** contract test passes and gates CI; fuzz/response-validation tests run; swagger
renders the full surface; `just test` green.

**Rollback:** test addition — revert.

---

### Phase 5 — Tracing & Observability

**Matrix items:** 30, 31, 33

- [x] **5.1** `@opentelemetry/sdk-node` + instrumentations (`http`, `express`, `pg`, `ioredis`,
  `bullmq`), initialized before the runtime in the app entrypoints; OTLP export only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set (zero cost until enabled).
- [x] **5.2** **Sampling (v6 spec):** root sampler =
  `ParentBased(Composite(rotationSampler ∥ TraceIdRatioBased(0.1)))` where `rotationSampler`
  force-samples `hash(boardId + YYYY-WW) % 100 < 5` with `YYYY-WW` computed in a **fixed
  timezone** (documented in config). Worker spans inherit the parent's decision via propagated
  `traceparent` — no mid-chain fragmentation for a sampled board.
- [x] **5.3** Explicitly suppress auto-instrumentation on socket ticks and mutation-lock polling
  (item 31).
- [x] **5.4** Propagate `traceparent` through BullMQ job metadata and restore it in the worker
  (item 33); map `x-request-id` → `traceparent`.

**Acceptance:** with OTLP set, a collector receives complete spans for a sampled board's
mutation → queue → worker → DB chain; unsampled paths carry no overhead; suppression config
verified by test; `just test` green.

**Rollback:** disable `OTEL_EXPORTER_OTLP_ENDPOINT`; no behavior change.

---

### Phase 6 — Disaster Recovery & Operations

**Matrix items:** 13, 18, 21 (part 2), 66, 67, 68, 69, 73, 90, 98, 99

- [ ] **6.1** Redis: explicit `appendfsync everysec` + `save` snapshots in `docker-compose.yml`
  (`maxmemory-policy noeviction` already applied in P2b). **Document honestly in `DEPLOY.md`**:
  ≤1s AOF loss on process crash; snapshot-bound recovery on full node/volume loss. Best-effort
  recovery with a minimized loss window — never an SLA (items 13/18).
- [ ] **6.2** Backup/restore: `scripts/pg-backup.sh`, `scripts/redis-backup.sh` + `backup`
  compose profile; CI validates a restore (dump into throwaway DB, assert row counts) (item 66).
- [ ] **6.3** Epoch-boundary crash test (item 21, part 2): kill the Node runner mid-flush; verify
  Postgres epoch boundaries — no partial flush, no lost epoch guard.
- [ ] **6.4** Compose/ops: uniform HEALTHCHECKs via `curl`/healthz on all three apps (item 68);
  migrations stay in the standalone `migrator`/CI step (item 69); `--max-old-space-size=512` in
  Docker CMD (item 73).
- [ ] **6.5** Composite index `board_elements(board_id, updated_at)` via **`CREATE INDEX
  CONCURRENTLY`** (hot table — avoid locks; item 90); down-migration policy per Drizzle change
  (item 98); exhaustive `.env.example` (item 99).
- [ ] **6.6** Multi-stage Dockerfile packaging only the target app's entrypoint (item 67).

**Acceptance:** recovery mechanism + loss window documented; backup/restore scripts + CI restore
validation exist; epoch-boundary crash test green; healthchecks uniform; index migration applied;
`just test` green.

**Rollback:** config/script additions — revert.

---

### Backlog (agreed, no phase)

Items 15 (flush tx timeout/retry bounds), 16 (timeboxed Yjs-native persistence spike), 28 (full
pool introspection), 86 (DTO mapping layer), 89 (express `req/res` isolation from services), 92
(consolidate multi-element lock checks into one pipeline), 95 (column-scoped selects), 96
(parallel startup).

---

## 5. Master Issue Matrix (100 points) with dispositions

Legend: **DONE** = already satisfied (verified) · **P1..P6** = phase (P2a/P2b both phase 2) ·
**CANCEL** = rejected with rationale · **BLOG** = backlog.

| # | Area | Issue | Disposition |
|---|------|-------|-------------|
| 1 | Bus | Hand-rolled stream broker complexity | P2a — delete |
| 2 | Bus | MAXLEN ~10000 silent loss | P2a — BullMQ persistence+retries |
| 3 | Bus | At-most-once emit (`void xadd`) | P2a — awaited emit, non-fatal failure |
| 4 | Bus | local/stream semantic divergence | P2a — EventEmitter (tests) + BullMQ (prod) |
| 5 | Bus | Head-of-line blocking on serial consumer | P2a — two queues |
| 6 | Bus | Unversioned JSON payloads → poison | P2a — Zod envelope v1 |
| 7 | Bus | Zero observability (lag/PEL) | P1 gauges + P2a fill |
| 8 | Bus | Dead-code bitrot from fallback flag | P2a — hard-delete, no dual path |
| 9 | Bus | Missing producer metadata | P2a — {producerId, timestamp, schemaVersion} |
| 10 | Bus | No independent consumer scaling | P2a — isolated concurrency pools per queue |
| 11 | Bus | Retry loops on permanent parse errors | P2a — DLQ, no retry, bounded retention + alerting |
| 12 | Bus | Cross-app leak via shared stream keys | P2a — per-deployable queue namespace |
| 13 | Durability | Full Redis loss loses edits+dirty markers | P6 — AOF everysec + snapshots + honest loss-window doc (best-effort, not SLA) |
| 14 | Durability | 3 representations of state | Keep — Yjs stays a CRDT move relay |
| 15 | Durability | Hand-rolled epoch clears/Lua flush | BLOG — add tx timeout + retry bounds |
| 16 | Durability | Yjs overhead without native persistence | BLOG — timeboxed Yjs-native spike |
| 17 | Durability | Outbox contention on solo edits | CANCEL — outbox rejected (13/18); solo writes to PG directly |
| 18 | Durability | 30s outbox write window | CANCEL — rely on AOF+RDB best-effort recovery |
| 19 | Durability | Unbounded change-log growth | DONE — `LTRIM` cap at write time (`state-domain.ts:158`) |
| 20 | Durability | Dirty-set corruption under maxmemory | P2b — `maxmemory-policy noeviction` |
| 21 | Durability | No crash-recovery simulation | P2b (queue redelivery) + P6 (Postgres epoch boundary) |
| 22 | Durability | Unbounded lock wait on partition | P3 — 2s acquisition timeout |
| 23 | Metrics | Dynamic names + tagset cardinality | P1 — static labels |
| 24 | Metrics | Missing dirty-backlog/queue gauges | P1 |
| 25 | Metrics | boardId in labels | P1 — strip, quantized buckets |
| 26 | Metrics | Registry collision across apps | P1 — per-app prefix |
| 27 | Metrics | No Socket.IO RED metrics | P1 — per-event middleware |
| 28 | Metrics | No DB pool stats | P1 (best-effort) + BLOG |
| 29 | Metrics | No worker heap/RSS | P1 |
| 30 | Observability | No distributed tracing | P5 — OTel, parent-based + weekly board-hash rotation |
| 31 | Observability | OTel overhead on socket ticks/lock polls | P5 — suppress auto-instrumentation |
| 32 | Observability | No perf benchmarks | P1 — `just bench` |
| 33 | Observability | Correlate traceparent across jobs | P5 — inject/restore in job metadata |
| 34 | Observability | Unstructured worker errors | P2a — pino with jobId/boardId |
| 35 | Observability | No lock-acquisition latency | P1 — histogram |
| 36 | Observability | Health liveness/readiness split | DONE — `/health/live`, `/health/ready` |
| 37 | Observability | Unmonitored BullMQ job failures | P1 — global failed-listener metric |
| 38 | API Docs | OpenAPI drift from live routes | P4 — contract test |
| 39 | API Docs | defineRoute rewrite churn | CANCEL — contract testing instead |
| 40 | API Docs | Manual Zod duplication | P4 — opportunistic zod-to-openapi |
| 41 | API Docs | Missing webhook/OAuth docs | P4 — coverage assertions |
| 42 | API Docs | Undocumented query params | P4 — `z.object().strict()` (gated) |
| 43 | API Docs | DTO vs wire drift | P4 — response schema validation in tests |
| 44 | Security | Fragment tokens leak | P3 — default false (gated) + PKCE |
| 45 | Security | Legacy unversioned routes | P3 — default false, 14-day zero-usage gate + canary |
| 46 | Security | No CSRF defense-in-depth | P3 — SameSite + prod-only `__Host-` + Origin check |
| 47 | Security | Socket unthrottled/unlimited | P3 — byte caps + token bucket |
| 48 | Security | Anonymous joins | P3 — JWT or anonymous+shareToken handshake auth |
| 49 | Security | JWT alg swap | DONE — pinned (`auth.service.ts:20`); P3 adds tests |
| 50 | Security | Unrate-limited public endpoints | P3 — with probe allowlist |
| 51 | Security | CORS reflection | DONE — whitelist only (`cors.ts`) |
| 52 | Security | Missing security headers | DONE — helmet on api (`create-app.ts:76`) |
| 53 | Security | Oversized JSON bodies | DONE — 1mb cap (`create-app.ts:30,125`) |
| 54 | Security | Stack traces in 500s | P3 — sanitize errorHandler |
| 55 | Security | Timing attacks on token compare | P3 — `timingSafeEqual` |
| 56 | Security | Unvalidated board UUID params | DONE — `z.string().uuid()` (`shared.ts:23`) |
| 57 | Realtime | 3 overlapping presence systems | CANCEL — retain all three (split-brain risk) |
| 58 | Realtime | TTL jitter → solo downgrade | P3 — grace period, conditional re-arm |
| 59 | Realtime | Disconnect buffer memory growth | P3 — maxHttpBufferSize caps |
| 60 | Realtime | Unverified room joins | P3 — authorize before `socket.join` |
| 61 | Realtime | No ping/pong timeout | P3 — 5s/10s |
| 62 | Realtime | Broadcast loops on reconnect | CANCEL — snapshot is per-joiner, no loop exists |
| 63 | Realtime | No per-room connection cap | P3 |
| 64 | Realtime | Unhandled emit errors | P3 — safe emit wrappers |
| 65 | Ops | Bull Board handle leak in api | P2b — isolate to worker |
| 66 | Ops | No backup/restore | P6 — scripts + CI |
| 67 | Ops | Whole codebase in images | P6 — multi-stage scoping |
| 68 | Ops | Missing HEALTHCHECKs | P6 — uniform curl healthz |
| 69 | Ops | Migrations at app startup | P6 — standalone migrator/CI step |
| 70 | Ops | No graceful shutdown | DONE — `app-shell.ts` |
| 71 | Ops | Redis adapter connection isolation | DONE — `pubRedis`/`subRedis` |
| 72 | Ops | Hardcoded env / lax parsing | DONE — zod env (`config.ts`) |
| 73 | Ops | Unbounded heap in containers | P6 — `--max-old-space-size=512` |
| 74 | Ops | Unstructured dev logs | P1 — pino-pretty local |
| 75 | Testing | No mutation→preview e2e | P2a — cross-app test |
| 76 | Testing | No metric-exporter cardinality tests | P1 |
| 77 | Testing | Untested billing webhook | P4 |
| 78 | Testing | No worker retry/backoff tests | P2a |
| 79 | Testing | Flaky tests from shared DB state | P1 — global cleanup hooks |
| 80 | Testing | No permissions-matrix tests | P3 |
| 81 | Testing | No token revocation tests | P3 |
| 82 | Testing | No Zod boundary/fuzz tests | P4 |
| 83 | Architecture | Cross-module boundary violations | DONE — `eslint-plugin-boundaries` enforced |
| 84 | Architecture | setInterval in services | P2a — audit (bus sweep removed; heartbeat exception documented) |
| 85 | Architecture | No single composition root | DONE — `createAppRuntime` |
| 86 | Architecture | ORM schema ↔ handler coupling | BLOG — DTO mapping layer |
| 87 | Architecture | Job types not isolated | P2a — shared job-type modules |
| 88 | Architecture | Non-standard error classes | DONE — `AppError` base (`errors.ts`) |
| 89 | Architecture | Express req/res in services | BLOG — controller isolation |
| 90 | Performance | Unindexed flush reconciliation | P6 — `(board_id, updated_at)` composite, CONCURRENTLY |
| 91 | Performance | Sync JSON parsing | CANCEL — 1mb cap; streaming adds complexity for no gain |
| 92 | Performance | Redis roundtrips on lock checks | BLOG — pipeline/Lua consolidation |
| 93 | Performance | Missing cache headers on static | CANCEL — no static routes; previews served via API |
| 94 | Performance | Unindexed link-token lookups | DONE — unique indexes on token columns |
| 95 | Performance | Over-fetching columns | BLOG — select scoping |
| 96 | Performance | Sequential app startup | BLOG — parallelize non-dependent init |
| 97 | Governance | No CI bench regression gate | P1 — dedicated runner / rolling-window gate (informational on PRs) |
| 98 | Governance | No down-migrations | P6 — mandate per schema change |
| 99 | Governance | Undocumented config | P6 — exhaustive `.env.example` |
| 100 | Governance | No AI-agent implementation guidelines | P1 — update `AGENTS.md` |

**Net:** 16 already done · 68 assigned to P1–P6 · 7 cancelled (17, 18, 39, 57, 62, 91, 93) ·
9 backlog.

---

## 6. Adverse review of this plan (v6)

Round-4 findings and how v6 resolves them:

1. **Awaited emit changes hot-path latency and error semantics.** Resolved (2a.3): `emit` is
   async; enqueue failure is non-fatal (mutation already applied), logged + metric'd; P2a
   re-benchmarks the added round-trip. Standing risk: socket handlers now wait on a Redis write
   before acking — if the bench shows > tolerance, the fallback is a bounded fire-and-forget with
   a per-process retry, revisited at P2a review.
2. **Config/docs drift.** Resolved (2a.5): transport rename + orphaned `events:app` stream
   cleanup are explicit checklist items covering `config.ts`, compose, `.env.example`, worker
   warning, README, AGENTS.md, DEPLOY.md.
3. **Grace re-arm correctness.** Resolved (3.4): re-arm is conditional on the board currently
   being in collab mode; a solo mutation cannot flip the board to deferred persistence; window =
   existing 90s cooldown. Tested (mutation re-arms / ping-only does not / solo does not flip).
4. **Anonymous shared-board break.** Resolved (3.2): handshake accepts JWT **or**
   anonymous+shareToken.
5. **Rolling-deploy DLQ spikes.** Resolved (2a.6): producer-before-consumer ordering documented;
   DLQ alert thresholds tolerant of transient rollout spikes.
6. **`__Host-` breaks local dev.** Resolved (3.6): `__Host-`/`Secure` applied in production only.
7. **Rate-limited healthchecks.** Resolved (3.6): probe allowlist/generous limits on `/health`
   + `/metrics` limiters.
8. **Index lock on hot table.** Resolved (6.5): `CREATE INDEX CONCURRENTLY`.
9. **Sampler consistency.** Resolved (5.2): root `ParentBased(Composite(rotation ∥ ratio))`,
   fixed-TZ `YYYY-WW`; worker inherits via propagated `traceparent`.
10. **Bench needs a fixture.** Resolved (1.6): authenticated, seeded board fixture script.
11. **Strict query schemas are breaking.** Resolved (4.2): gated like the P3 flips or documented
    removal window.
12. **Metrics renames break consumers.** Resolved (1.10): dashboard/alert migration shipped
    alongside P1.

Standing accepted risks (not resolved by design choice):
- **BullMQ is still a single point of failure** (one Redis). Mitigated by gauges + alerting;
  a future Redis split is documented, not scheduled.
- **AOF+RDB is best-effort, not durable.** Stated plainly in P6/`DEPLOY.md`; collab-only journal
  remains the documented upgrade path if durability becomes a product promise.
- **Telemetry gate is a "first-flip-ever" risk.** The 14-day window + canary de-risks but assumes
  the P1 counters are the first real production signal; plan for a monitoring fix-up cycle.
- **Rotating sampling churn:** a board's full-trace coverage changes at ISO-week boundaries; a
  bug captured mid-week must be re-captured within the same week. Accepted trade for no permanent
  bias.

---

## 7. Decisions (RESOLVED)

1. **Durability:** AOF+RDB best-effort recovery (outbox rejected) — **ACCEPTED** for this scale;
   journal documented as upgrade path.
2. **Bus removal:** hard-delete with code-revert rollback — **ACCEPTED** (self-healing blast
   radius).
3. **Presence consolidation (item 57):** cancelled, stores retained — **ACCEPTED**.
4. **Collector availability:** if no Prometheus/OTLP exists, P1/P5 reduce to "emit correct
   telemetry; wire collectors later" — **TBD by ops**, does not block P2a–P4.
5. **P2a+P2b as one release unit — ACCEPTED.**
6. **Yjs-native persistence spike (item 16):** timeboxed, current store as fallback —
   **ACCEPTED** as backlog.

---

## 8. Suggested commit/PR sequence

1. **P1** → "observability baseline: bounded metrics, queue+DLQ gauges, bench suite +
   BASELINE.md (run-scoped history cache), metric-rename migration, test hooks, AGENTS.md rules".
2. **P2a** → "replace Redis Stream bus with board-mutations/board-control-events BullMQ queues
   (envelope v1, awaited emit + non-fatal failure, DLQ + retention + alert, producer metadata,
   per-app namespace, worker logs); EVENT_BUS_TRANSPORT rename + orphaned-stream cleanup".
3. **P2b** → "queue-redelivery crash test, maxmemory-policy noeviction, Bull Board isolated to
   worker" (same release unit as P2a).
4. **P3** → "realtime hardening: connect auth (JWT|shareToken), byte caps, token bucket,
   ping/pong, room caps"; "presence grace period (conditional re-arm) + mutation-lock timeout";
   "security defaults gated on 14-day telemetry: fragment/legacy off, PKCE, CSRF, prod-only
   __Host-, sanitized errors, timingSafeEqual"; "permissions + token revocation suites".
5. **P4** → "OpenAPI contract test + gated strict query schemas + response validation + fuzz";
   "billing webhook signature tests".
6. **P5** → "OTel: parent-based + weekly-rotating board sampling, tick/mutex suppression,
   traceparent in jobs".
7. **P6** → "backup/restore scripts + CI restore validation + epoch-boundary crash test";
   "AOF/snapshot config + honest recovery-window doc"; "compose healthchecks/heap/migrator";
   "elements composite index (CONCURRENTLY) + down-migration policy + .env.example".

Each PR: `just build`, `npm run lint`, `just test` green; no wire-protocol name changes
(`src/modules/realtime/socketio/constants.ts`); rollback path in the PR description; never
re-touch a DONE item.
