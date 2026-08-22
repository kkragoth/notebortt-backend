# Phase 0 — Modular Monolith First

> Goal: make the codebase *deployable as multiple K8s workloads* and *splittable
> into services later* without rewriting anything. No new infrastructure yet.

## Why modular monolith first

- The realtime domain (CRDT rooms, mutation processing, presence) shares
  in-memory state; premature service splits would force network hops through
  hot paths.
- Kubernetes rewards processes that scale independently. We get that benefit by
  **splitting entrypoints, not codebases**.
- Module seams discovered now become service boundaries later (if ever needed).

## Current shape (what we already have)

`src/` already clusters naturally:

| Cluster | Contents | Nature |
|---|---|---|
| platform | `config`, `db`, `redis`, `lib`, `middleware`, `observability` | cross-cutting infra |
| identity/auth | `routes/auth`, `services/auth.service`, `user.service` | request-scoped |
| workspace | `routes/workspaces`, `services/workspace/*` | request-scoped |
| board catalog | `routes/boards` (CRUD/members/invites/sharing), `services/board/*` | request-scoped |
| board realtime | `socketio/*`, `ws/*`, `mutations/*`, `services/board-state/*` | long-lived stateful |
| async jobs | `services/preview-job.service`, `board-persistence.service`, `redis-cleanup.service`, `board-preview.service` | background workers |
| billing | `routes/billing`, `services/billing/*` | request + webhook |

Problems to fix before K8s:

1. `src/index.ts:33-36` starts **three workers inside the API process**. Scaling
   API replicas multiplies workers (preview locks mostly hide it today, but CPU
   is stolen from websocket traffic and lock contention grows).
2. No import-direction rules → nothing stops a route importing
   `socketio/crdt-room.js` internals.
3. Cross-module communication is implicit function calls anywhere.

## Step 1 — Define modules and public surfaces

Create one barrel per module. Everything outside the module may only import the
barrel.

```
src/
  modules/
    identity/      index.ts        ← only public exports (service factories, types)
    workspace/     index.ts
    boards/        index.ts
    board-realtime/index.ts
    jobs/          index.ts
    billing/       index.ts
  platform/        config.ts db/ redis/ lib/ observability/
```

Rules (enforced in step 3):

- `modules/X/**` may import `platform/**`, its own internals, and other modules'
  `index.ts` **only**.
- `modules/X` must never import `modules/Y/<file>` directly.
- `platform/**` never imports `modules/**`.
- Route files move into their module (`modules/boards/routes/…`) with thin
  registration re-exported for `create-app.ts`.

## Step 2 — Split entrypoints (same image, two commands)

New build outputs:

```
dist/api.js       ← HTTP + Socket.IO/ws only
dist/workers.js   ← persistence + cleanup + preview workers + heartbeat only
```

Changes:

1. `src/index.ts` becomes a thin composition root that reads `process.env.PROCESS_ROLE`
   (`api` | `workers` | `all`) and boots accordingly. Default `all` keeps local
   dev / compose behavior identical.
2. `package.json` scripts:
   ```json
   "start:api": "node dist/index.js --role=api",
   "start:workers": "node dist/index.js --role=workers"
   ```
   Dockerfile stays untouched (one image) — K8s will set the command per
   Deployment.
3. Workers must be idempotent across replicas *before* scaling them:
   - preview jobs: already ZSET + lock based (`PREVIEW_LOCK_PREFIX`) ✔
   - persistence flush + cleanup: audit for "take N oldest" loops and add
     Redis SET NX locks mirroring the preview pattern where missing.

**Why this matters for phase 1:** API Deployment gets HPA on RPS/conns;
worker Deployment scales on queue depth — independently, same image.

## Step 3 — Enforce boundaries automatically

Add `dependency-cruiser` (dev dep) + npm script:

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    { name: 'no-deep-cross-module-imports',
      comment: 'Import other modules via their index.ts only',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/([^/]+)/', pathNot: ['^src/modules/$1(/index\\.ts)?$'] },
    },
    { name: 'platform-is-a-lib',
      from: { path: '^src/platform/' },
      to:   { path: '^src/modules/' },
    },
  ],
}
```

```jsonc
// package.json
"lint:arch": "depcruise src --config .dependency-cruiser.cjs"
```

Wire `just lint-arch` and CI gate alongside `just build`.

## Step 4 — Introduce an `EventBus` port (prepares Phase 4)

Define the seam now so RabbitMQ/Kafka become adapter swaps, not rewrites:

```ts
// src/platform/events/types.ts
export interface DomainEvent<T = unknown> {
  id: string            // uuid
  type: string          // 'board.updated' | 'billing.subscription.changed' | ...
  aggregateId: string   // boardId / workspaceId / ...
  occurredAt: string    // ISO timestamp
  payload: T
}

export interface EventBus {
  publish(event: DomainEvent): Promise<void>
  subscribe(type: string, handler: (e: DomainEvent) => Promise<void>): () => void
}
```

First implementation: `InMemoryEventBus` (same process, awaited inline).
Emit events from domain logic at natural points (board updated/deleted,
member added, subscription changed) but keep behavior unchanged — this is pure
instrumentation until brokers arrive.

Also add **transactional outbox tables** now (cheap, unlocks reliable brokers):

```
outbox_events(id uuid pk, type text, aggregate_id text, payload jsonb,
              created_at timestamptz default now(), published_at timestamptz null)
```

Domain writes insert into `outbox_events` in the same transaction; a small
dispatcher polls and hands rows to the `EventBus`. When Kafka arrives, the
publisher changes; history stays replayable.

## Step 5 — Data ownership rules

Single Postgres schema stays (fine for a monolith), but adopt:

- Each module owns its tables (document ownership in
  `src/db/schema/*.ts` headers: e.g. `users.ts` → identity, `workspaces.ts` →
  workspace+memberships, `boards.ts` → boards).
- Cross-module reads go through module services, not ad-hoc joins, starting with
  any *new* query. Legacy joins migrate opportunistically.
- Redis key namespaces follow module prefixes (`preview:*` = jobs module,
  dirty-board keys = realtime module — see `src/services/board-state/keys.ts`).

## Verification

```bash
just build          # tsc clean
npm run lint:arch   # boundaries respected
just test           # vitest green
# both roles boot against compose stack:
docker compose -f docker-compose.yml up -d postgres redis-realtime redis-jobs
PROCESS_ROLE=api     node dist/index.js   # health OK, no worker logs
PROCESS_ROLE=workers node dist/index.js   # worker logs, no HTTP listen
```

## Exit checklist

- [ ] Modules + barrels exist; `lint:arch` passes in CI
- [ ] `--role=api` / `--role=workers` boot paths verified
- [ ] All background loops replica-safe (locks or ZSET claims)
- [ ] `EventBus` port + `InMemoryEventBus` merged; ≥3 domain events emitted
- [ ] Outbox table migration generated (`just db-generate`) and applied locally
