# Invitation Microservice — Plan & Tutorial

> Scope: evolve the existing **TypeScript/Express monolith** into a microservices
> architecture incrementally, starting with the invitation domain. This doc is both
> the plan and a teaching tutorial. It complements `microservices_start.md` (the
> big-picture vision); this one is the concrete, low-risk path we can actually build.

---

## 1. TL;DR — The Verdict

**Yes, an "Invitation Microservice" is a good first microservice — but not the naive
version.**

- **Bad:** copy the invitation endpoints into a new service and call it done.
  Result: a *distributed monolith* (shared DB, chatty joins, no independent
  ownership). Interviewers see through this instantly.
- **Good:** keep the transactional write path in the monolith, publish invitation
  **lifecycle + access events**, and let microservices consume them. Then extract
  the membership **read model / write path** once the event stream exists.

Two-phase plan:

| Phase | What you build | What it teaches |
|---|---|---|
| **1 — Event backbone** | Outbox table + Kafka event log + email worker (Kafka consumer group; optional RabbitMQ) | The hard 70%: outbox pattern, at-least-once, event vs command, message brokers |
| **2 — membership-api** | Real microservice: own DB, own migrations, own API, gateway routing | Data ownership, deployment independence, read-model projection |

---

## 2. Why "just extract the invitation API" is a trap

Your invitation code is not an island today. Look at the write paths:

- `createWorkspaceInvitation` inserts into `workspace_invitations`
  (`src/services/workspace/invitations.ts:40`)
- `acceptWorkspaceInvitation` runs a **DB transaction** that updates the invitation,
  inserts a `workspace_members` row, and reads `workspaces`
  (`src/services/workspace/invitations.ts:139` / `:151`)
- Same story for boards: `acceptBoardInvitationByToken` mutates invitation + board
  membership atomically (`src/services/board/invitation-transitions.ts:53`)

If you lift these into a separate service, that service still needs `users`,
`workspaces`, and `boards` tables. So you either share one database (no ownership
split = not a real microservice) or you do distributed joins (a chatty antipattern).
Either way: distributed monolith.

### The definition that matters

A microservice is **independently deployable** AND **owns its data**. The boundary
is not "fewer lines per file". It's:

1. Independent deployment (own process, own Docker image, own scaling)
2. Independent data ownership (own tables / DB — no foreign keys across services)
3. Independent failure domain (one service crashing doesn't take down another)
4. Communication via network + events, not shared code or shared DB

That's the mental model. Everything below follows from it.

---

## 3. Architecture Overview

Invitation lifecycle events flow through the brokers. The monolith keeps owning the
transactional writes; downstream services react.

```
                       ┌───────────────────────────────┐
                       │            nginx               │
                       │  /api/*        → core monolith │
                       │  (Phase 2) /api/invitations/*  │
                       └──────────────┬────────────────┘
                                      │  HTTP
                       ┌──────────────▼───────────────┐
                       │      core monolith (TS)       │
                       │  workspace/board invitation   │
                       │  write paths (transactions)   │
                       │  + outbox_events table         │
                       └──────────────┬───────────────┘
                                      │ outbox poller (relay)
                       ┌──────────────▼───────────────┐
                       │        Kafka (log of record)  │
                       │   topic: invitations           │
                       │   replayable, many consumers   │
                       └───────┬──────────────┬───────┘
                               │              │
               Phase 2:        │              │ Phase 1:
        invitations-api       │              │ Kafka→Rabbit bridge
        (own DB, read model)  │              │ (filters *.created)
                               │              └──────────▼───────────────┐
                               │                       │  RabbitMQ (work) │
                               │                       │  queue:          │
                               │                       │  notifications.  │
                               │                       │  email           │
                               │                       └──────────┬───────┘
                               │                                  │
                               │                          ┌───────▼───────┐
                               │                          │ email worker  │
                               │                          │ (logs/sends)  │
                               └──────────────────────────┴───────────────┘
```

> **Boundary correction — read §6C.1 before Phase 2:** the `invitations-api` box
> below is renamed `membership-api`, and boards get their own `boards-api` (Phase 3).
> The event-flow shape (monolith → Kafka → consumer services) is unchanged.

> **Default Phase-1 wiring (see §6 Step 8):** the "Kafka→Rabbit bridge / RabbitMQ
> work queue / email worker" branch below is the **optional two-broker variant**. The
> default puts the email worker directly on the `invitations` topic as a Kafka consumer
> group with a dead-letter topic — one broker, one failure domain. The diagram keeps the
> two-broker shape only because it shows the *contrast* (log vs work), which is the
> teaching point; run RabbitMQ only when a second consumer justifies it.

### Kafka vs RabbitMQ — why both (this is the resume gold)

| | Kafka | RabbitMQ |
|---|---|---|
| Nature | Append-only **event log** | Message **broker / work queue** |
| Unit | Events on a partitioned topic, replayed from offsets | Messages consumed from a queue, acked per-message |
| Best for | "This happened" — many systems care, now or later (replay, audit, read models) | "Do this work" — one job, one worker, retries, DLQ |
| Guarantee | At-least-once per partition, ordering by key | At-least-once with manual ack; dead-letter exchanges |
| In this project | System of record for the invitation lifecycle | Task distribution for "send email" notifications — used only in the optional two-broker variant (§6 Step 8) |

**Rule of thumb to memorize:** *"Kafka for 'this happened', RabbitMQ for 'do this
work'."*

- Kafka is the source of truth stream. Any future service (audit, analytics,
  read-model) can consume `invitations` independently or replay it.
- RabbitMQ decouples the email task from the event log, so the worker can ack/retry
  per message without touching Kafka's history. **Phase 1 defaults to a Kafka consumer
  group for email instead** (its `commitOffset` stands in for `ack`, a DLT for a DLX);
  add RabbitMQ when you need true per-message retry/backoff or a task queue for
  something besides email.

### The transactional outbox pattern (mandatory)

Directly publishing to Kafka/RabbitMQ inside a request handler is fragile: if the
process crashes after the DB commit but before the publish, the event is **lost
forever** and the invitee never gets an email.

The industry answer:

1. In the **same DB transaction** that writes the invitation, also insert a row into
   an `outbox_events` table.
2. A **relay** process polls `outbox_events` for `pending` rows and publishes them to
   Kafka.
3. Only after a successful publish does it mark the row `published`.

Result: "invitation saved ⟺ event will eventually be published". This is
**at-least-once** delivery — consumers must be idempotent (more below). This one
pattern is worth its weight in interviews.

---

## 4. Event Catalog (invitation domain)

Topic: `invitations`. Partition key: `aggregate_id` (invitation id) → per-invite
ordering. Message value carries the event type.

| Event | Producer | Consumers (now/future) | Payload highlights |
|---|---|---|---|
| `workspace.invitation.created` | monolith | email worker, membership-api, audit | invitationId, workspaceId, invitedBy, recipientEmail, role, expiresAt — **no token** (R7) |
| `workspace.invitation.accepted` | monolith | invitations-api, audit | invitationId, workspaceId, userId, recipientEmail, role |
| `workspace.invitation.declined` | monolith | invitations-api, audit | invitationId, workspaceId, recipientEmail |
| `workspace.invitation.revoked` | monolith | invitations-api, audit | invitationId, workspaceId, recipientEmail, revokedBy |
| `board.invitation.created` | monolith | email worker, membership-api, audit | invitationId, boardId, invitedBy, recipientEmail, permission, expiresAt — **no token** (R7) |
| `board.invitation.accepted` | monolith | invitations-api, audit | invitationId, boardId, userId, recipientEmail, permission |
| `board.invitation.declined` | monolith | invitations-api, audit | invitationId, boardId, recipientEmail |
| `board.invitation.revoked` | monolith | invitations-api, audit | invitationId, boardId, recipientEmail, revokedBy |

> **Tokens never ride the stream.** The `.created` events carry who + when, **never**
> the bearer token. Whatever the email worker needs to build the invite link is
> delivered over a private channel (§6 Step 8), not the domain log this catalog
> describes. This resolves the contradiction the public review caught (§6C.3-B).

Wire format (value):

```json
{
  "eventId": "<outbox row id>",
  "eventType": "workspace.invitation.created",
  "aggregateType": "workspace.invitation",
  "aggregateId": "<invitation id>",
  "occurredAt": "2026-08-08T12:00:00.000Z",
  "payload": { "...": "..." }
}
```

---

## 5. Repository Layout (target)

Keep it a monorepo. The rule that prevents entropy: **services talk to each other
only through the `contracts` package** — never by importing each other's code.

```
note-canva-backend/
├── packages/
│   ├── contracts/            # Phase 2: versioned event + HTTP schemas (Zod), AsyncAPI spec
│   ├── core/                 # Phase 2: your current monolith moves here
│   ├── membership-api/       # Phase 2: own DB, owns members + invitations, emits access facts
│   ├── boards-api/           # Phase 3: own DB, owns board content + local access projection
│   └── notifications-worker/ # Phase 2: Kafka consumer group → email provider (RabbitMQ only in the two-broker variant)
├── src/                      # ← where you are now (Phase 1 stays here)
│   ├── events/               # Phase 1: outbox, relay, email worker (+ optional bridge)
│   └── ...
└── docker-compose.yml
```

Ground rules (Phase 2):
- Each service: own Postgres **schema/DB**, own migrations, own Dockerfile, own
  `/health` endpoint.
- No shared ORM models across service boundaries; only `contracts` DTOs/events.
- nginx routes `/api/invitations/*`, `/api/workspaces/*/members*`,
  `/api/boards/*/members*` → membership-api, everything else → core (Phase 3:
  `/api/boards/*` content → boards-api).

---

## 6. Phase 1 — Event Backbone (Build It)

> Where: current repo, in-process workers (like the existing
> `previewJobService.startWorker()` at `src/index.ts:35`). Nothing is deployed
> separately yet — but each worker is written as if it could be.

### Step 1 — Infrastructure

Add to `docker-compose.yml`. **Kafka is the only required service** (default email
worker is a Kafka consumer group, §6 Step 8); RabbitMQ is used only by the optional
two-broker variant:

```yaml
kafka:
  image: apache/kafka:3.7.0
  ports:
    - "9094:9092"          # host access for debugging (localhost:9094)
  environment:
    KAFKA_NODE_ID: 1
    KAFKA_PROCESS_ROLES: broker,controller
    KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093,PLAINTEXT_HOST://0.0.0.0:9094
    KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,PLAINTEXT_HOST://localhost:9094
    KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,PLAINTEXT_HOST:PLAINTEXT
    KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
    KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
  volumes:
    - kafka_data:/var/lib/kafka/data

# Optional — only for the two-broker (Kafka→Rabbit) variant, §6 Step 8.
rabbitmq:
  image: rabbitmq:3-management-alpine
  ports:
    - "5672:5672"     # AMQP
    - "15672:15672"   # management UI (localhost:15672, guest/guest)
  healthcheck:
    test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
    interval: 10s
    timeout: 5s
    retries: 10

volumes:
  kafka_data:
```

Note the two Kafka listeners: `PLAINTEXT://kafka:9092` for containers and
`PLAINTEXT_HOST://localhost:9094` for host tools. This is a classic gotcha.

### Step 2 — Config

Add to `src/config.ts` env schema + `AppConfig`:

```
KAFKA_BROKERS=localhost:9094            # comma-separated
RABBITMQ_URL=amqp://localhost:5672
EVENT_BACKBONE_ENABLED=true             # off for tests / minimal local runs
```

In `docker-compose.yml` the backend envs use the container hostnames:
`KAFKA_BROKERS=kafka:9092`, `RABBITMQ_URL=amqp://rabbitmq:5672`.

### Step 3 — Dependencies

```bash
npm i kafkajs amqplib
npm i -D @types/amqplib
```

### Step 4 — Outbox table

New file `src/db/schema/outbox.ts`:

```ts
import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'), // pending | published
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
})
```

Export from `src/db/schema.ts`, then generate the migration:

```bash
npx drizzle-kit generate
just db-migrate
```

Add an index on `(status, created_at)` for fast relay polling.

### Step 5 — Event contracts

`src/events/contracts.ts` — constants + typed payload builders so producers and
consumers share one source of truth inside the monolith (Phase 2 promotes this to
`packages/contracts`).

```ts
export const EVENTS = {
  workspaceInvitationCreated: 'workspace.invitation.created',
  workspaceInvitationAccepted: 'workspace.invitation.accepted',
  workspaceInvitationDeclined: 'workspace.invitation.declined',
  workspaceInvitationRevoked: 'workspace.invitation.revoked',
  boardInvitationCreated: 'board.invitation.created',
  boardInvitationAccepted: 'board.invitation.accepted',
  boardInvitationDeclined: 'board.invitation.declined',
  boardInvitationRevoked: 'board.invitation.revoked',
} as const

export const KAFKA_TOPIC_INVITATIONS = 'invitations'
```

### Step 6 — Instrument the write paths (the core lesson)

`src/events/outbox.ts`:

```ts
import type { Database } from '../db/client.js'
import { outboxEvents } from '../db/schema.js'

export function appendOutboxEvent(
  db: { insert: Database['insert'] },   // accepts db OR a transaction handle
  event: { aggregateType: string; aggregateId: string; eventType: string; payload: unknown },
) {
  return db.insert(outboxEvents).values({ ...event, payload: event.payload })
}
```

> The parameter is typed as `{ insert: ... }` so it accepts **either** the db **or** a
> transaction handle — that's how the outbox row lands in the *same* transaction as
> the invitation.

Hook into the **workspace** path (`src/services/workspace/invitations.ts`):

- `createInvitation`: wrap insert + outbox append in `db.transaction`, append
  `workspace.invitation.created` after the row is inserted.
- `acceptInvitation`: inside the existing transaction (`:151`), append
  `workspace.invitation.accepted` after `workspaceMembers` is inserted.

Hook into the **board** path (`src/services/board/invitation-transitions.ts`):

- `createBoardInvitation` (`:28`): same-transaction outbox append of
  `board.invitation.created`.
- `acceptBoardInvitationByToken` (`:53`): append `board.invitation.accepted`.
- `declinePendingInvitationByToken` (`:88`): append `board.invitation.declined`
  (or `workspace.invitation.declined` depending on which table it updated).
- `revokeBoardInvitation` (`:125`): append `board.invitation.revoked`.

Rule: **the outbox append must not be in a separate request/transaction.** That is
the whole point of the pattern.

### Step 7 — Kafka relay

`src/events/kafka-relay.ts` — polls `outbox_events` where `status = 'pending'`,
publishes each to Kafka, marks `published`. Run on a `setInterval` like the existing
`previewJobService`.

```ts
async function runOnce(): Promise<void> {
  const pending = await db.select().from(outboxEvents)
    .where(eq(outboxEvents.status, 'pending'))
    .orderBy(outboxEvents.createdAt)
    .limit(BATCH_SIZE)

  for (const row of pending) {
    await producer.send({
      topic: KAFKA_TOPIC_INVITATIONS,
      messages: [{ key: row.aggregateId, value: JSON.stringify({ eventId: row.id, eventType: row.eventType, aggregateType: row.aggregateType, aggregateId: row.aggregateId, occurredAt: new Date().toISOString(), payload: row.payload }) }],
    })
    await db.update(outboxEvents).set({ status: 'published', publishedAt: new Date() })
      .where(eq(outboxEvents.id, row.id))
  }
}
```

Failure behavior: if `producer.send` throws, leave the row `pending` — next tick
retries it. That's the at-least-once guarantee. (Kafka producer config:
`idempotence: true` reduces duplicates within a batch.)

**Relay under load.** The naive poll is correct at Phase-1 scale but has two sharp
edges once writes grow:

- **Two relay processes would double-publish.** If you ever run more than one relay
  (or a restart overlaps a slow tick), both claim the same `pending` rows. Guard with
  a row lock: in SQL, `SELECT ... WHERE status='pending' ORDER BY created_at LIMIT N
  FOR UPDATE SKIP LOCKED`; in Drizzle, add `.for('update', { skipLocked: true })`.
  The index on `(status, created_at)` (§6 Step 4) already covers the ordering.
- **The pending set must stay small, and the table must not bloat.** Range-partition
  `outbox_events` by date and `DROP PARTITION` expired ranges — partition drops are
  instant with zero IO, unlike `DELETE`, which on a high-throughput outbox generates
  MVCC dead tuples that the poll/update loop keeps churning and that auto-vacuum
  struggles to reclaim. If partitioning feels heavy early, batch-clean published
  rows continuously (small `DELETE … LIMIT` batches on the `(status, published_at)`
  index) instead of one weekly `DELETE`.

**Why not CDC / Debezium?** Postgres logical replication *is* the scale answer — but
it pulls the transactional output from the monolith into an external pipeline and
removes the very teaching property the outbox gives you (relay = idempotent,
self-contained publisher you control and can retry). Defer CDC to Phase 4 hardening;
for this phase `FOR UPDATE SKIP LOCKED` + small pending set is the right-sized fix.

### Step 8 — Email worker (default: Kafka consumer group + DLT)

**Email worker** (`src/events/email-worker.ts`): a Kafka consumer group on the
`invitations` topic that reacts to `*.created` events and logs "would send invitation
email to <recipient>" (swap for a real SMTP/transactional provider later). It commits
its offset **only after** the side effect completes; on failure it does not commit
and, after the retry budget, the event lands on a **dead-letter topic** for manual
inspection/replay. This is the **default Phase-1 shape** — one broker, one failure
domain, no extra infrastructure.

**Why Kafka-as-queue by default, and not RabbitMQ?** The only consumer in Phase 1 is
email. A work queue buys us per-message ack granularity and rich routing — traits we
don't need yet — at the cost of a second broker (docker-compose service, monitoring,
failure vector). Kafka consumer groups already give at-least-once, ordered, replayable
offsets: `commitOffset` stands in for `ack`, and a DLT stands in for a dead-letter
exchange. The honest caveat to keep: you lose per-message retry-with-backoff and a DLX,
the one thing Rabbit's `nack` does that Kafka groups don't do as naturally.

**Tokens never travel in events — but the email worker still has to build a link.**
The event carries only `invitationId` + recipient (R7). To assemble the invite URL,
the worker must not receive the raw token in the stream. **Bake a capability into the
outbox row at write time** (T3, §6C.4): the same transaction that writes the
invitation also mints a **short-lived, signed claim** (HMAC/JWT bound to
`invitationId` + `expiresAt` + the worker's verifying key) and stores it *in the
private outbox payload*. The email worker verifies the signature **locally** — no
network round-trip — and unwraps an accept URL that is useless for anything else and
expires on its own. Do **not** compensate with a just-in-time HTTP fetch from the
worker back into membership-api: that turns an async worker into a synchronous client
of the primary service, so a slow/deploying membership-api stalls the email consumer,
backs up the partition, and couples the two scaling domains (T3). The claim is signed,
single-purpose, and expiring, so it is NOT the bearer token and may ride the
`notifications.email` envelope — but it should *not* ride the public `invitations`
log (R-S3): keep it in the private payload, or in the two-broker variant below, in the
private queue only, scope-restricted, never replayable to audit/analytics consumers.

> **Optional two-broker variant (the resume gold was always the *choice*, not the
> hardware).** If you want the log-vs-work contrast in the stack, the earlier design
> still stands: a Kafka→Rabbit bridge (`src/events/bridge.ts`) filters `*.created`
> onto a `notifications.email` queue, and a RabbitMQ consumer `ack()`/`nack()`s per
> message to a dead-letter exchange. Kafka keeps the replayable history; RabbitMQ
> carries the ephemeral work. Run this only when a second reason to operate RabbitMQ
> exists (scheduled dispatch, REST-to-message fan-out). Until then, the single broker
> is the correct default.

### Step 9 — Wire it up

`src/app/runtime.ts`: create relay + email worker alongside the existing workers (and
the bridge **only** in the two-broker variant). `src/index.ts`: start them (gated by
`EVENT_BACKBONE_ENABLED`), mirroring:

```ts
const stopRelay = runtime.eventRelay.start()
const stopEmailWorker = runtime.emailWorker.start()
// two-broker variant only:
const stopBridge = runtime.kafkaRabbitBridge.start()
```

### Step 10 — Run it & verify

```bash
just db-migrate && just db-seed
just dev                      # brings up kafka + backend (+ rabbitmq in the two-broker variant)
```

1. Hit the workspace invite endpoint (or run a seed script that creates an invite).
2. Watch the relay log: outbox row → Kafka.
3. Watch the email worker logs: `would send invitation email to ...`.
4. Check `SELECT * FROM outbox_events;` → rows flip pending → published.
5. Inspect UI: Kafka via `kcat -L -b localhost:9094` or a UI tool (RabbitMQ at
   `http://localhost:15672`, guest/guest, only in the two-broker variant).

### Step 11 — Tests

The invitation service tests mock the `db` object
(`test/workspace.service.test.ts`, `test/board.service.test.ts`). They break when
you add outbox writes because the mock needs a `.transaction` + the extra `insert`.
Update the mocks to mirror the new calls, and add assertions that the outbox row is
written *in the same transaction* (e.g. outbox insert uses the same `tx` object).
This test is your proof of the outbox pattern — keep it.

### At-least-once → consumer idempotency

Because the relay can redeliver, consumers must be idempotent. For the email worker
in Phase 1 that means tracking sent `eventId`s (Redis set, or a `sent_emails`
table). For Phase 2 read models, key by `eventId` and use `INSERT ... ON CONFLICT DO
NOTHING`. Say this out loud in interviews — it shows you understand delivery
semantics.

---

## 6B. Phase 1b — Board & Workspace Access as a Projection

### Why this section exists

The `invitations` events answer *"someone was invited / accepted"* — they do **not**
give any service the ability to decide *"does user X have access to board Y?"*. That
decision sits on the hot path (every board read and mutation), so it must be answered
from a **local projection**, never a cross-service join. This section converts the
current single-join oracle, `checkBoardAccess` (`src/services/board/access.ts:31`),
into an event-driven projection.

There are **two permission axes** in the codebase today. Keep them apart or the
projection is wrong:

| Axis | Question | Current answer | Hot path? |
|---|---|---|---|
| **Content permission** | Can the user *view / edit* the board? | `checkBoardAccess` (access.ts:31) | Yes — every request |
| **Manage-access permission** | Can the user *manage members / invites / link-share / delete*? | workspace role, `canManageBoardAccess` (`src/routes/boards/shared.ts:163`) | Admin routes only |

Both derive from the *same facts* (workspace role + board membership), so **one
event feed powers both** — the consumer stores role and permission in separate
columns (§6B.4).

### 6B.1 Access event catalog (topic: `access`)

Partition key = `aggregateId`: `boardId` for board-scoped events, `memberId` (the
`workspace_members.id`) for workspace-membership events. Kafka's per-key ordering is
a **hard invariant** the projection depends on (§6B.5).

| Event | Emitted when | Payload highlights |
|---|---|---|
| `board.created` | board created (`lifecycle.ts:7`), duplicated (`lifecycle.ts:30`) | boardId, workspaceId, createdBy |
| `board.deleted` | board deleted (`lifecycle.ts:49`) | boardId, workspaceId |
| `board.link_share.updated` | share toggled / token rotated (`sharing.ts:11`, `:31`) | boardId, workspaceId, enabled, permission — **never the token** |
| `board.access.granted` | board invite accepted (`invitation-transitions.ts:53`) or direct add/upsert (`members.ts:11`) | boardId, userId, permission, grantedBy, source `board_invitation`\|`direct_add` |
| `board.access.permission_changed` | member permission patched (`members.ts:24`) | boardId, userId, oldPermission, newPermission, changedBy |
| `board.access.revoked` | member removed / left (`members.ts:31`, `:35`) | boardId, userId, revokedBy, source `member_removed`\|`left` |
| `workspace.member.added` | workspace created with owner (`core.ts:10`), workspace invite accepted (`invitations.ts:182`) | workspaceId, memberId, userId, role, addedBy |
| `workspace.member.role_changed` | workspace member role changed | workspaceId, memberId, userId, oldRole, newRole, changedBy |
| `workspace.member.removed` | workspace member removed (`core.ts:67`) | workspaceId, memberId, userId, oldRole, removedBy |

Example — a board-invite accept publishes **two** outbox rows in the one
transaction: `board.invitation.accepted` (→ `invitations`, answers "the invite
lifecycle") and `board.access.granted` (→ `access`, answers "the user can now
open the board"). They answer different questions; they are not alternatives.

> **Cross-topic rule (hard):** Kafka orders events only within one partition of one
> topic. Two outbox rows published to *different* topics have **no ordering
> guarantee between them** — a consumer of `access` may receive `board.access.granted`
> before the `invitations` consumer has seen `board.invitation.accepted`. Therefore
> every event emitted alongside another must be **self-contained**: it must carry
> everything its own consumers need (both rows above do), and no consumer may rely
> on the relative order of events that live in different topics. If two facts are
> causally dependent and a consumer needs both, emit one event on one topic.

The `board.created` / `board.deleted` events are **load-bearing**, not decoration:
the projection uses them to enumerate boards per workspace (R6 in §6C). Ship them.

### 6B.2 Outbox table change (one line)

The §6 Step 4 outbox schema can't route `access`. Add a topic + a *real* occurrence
time:

```ts
export const outboxEvents = pgTable('outbox_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  eventType: text('event_type').notNull(),
  topic: text('topic').notNull(),   // NEW: 'invitations' | 'access' | ...
  payload: jsonb('payload').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(), // NEW — DB clock (NOW()), never app time
  sequence: bigint('sequence', { mode: 'number' }).notNull().default(0), // NEW — per-aggregate monotonic; NOT NULL — NULL breaks the tuple guard (T2)
  status: text('status').notNull().default('pending'), // pending | published
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
})
```

The relay (Step 7) forwards `topic` and `occurredAt` **from the outbox row** — it
must never re-stamp publish time (`new Date()`). The projection orders events by
occurrence time, not delivery time.

Two clock rules this schema enforces:
- `occurredAt` is assigned by the **DB** (`defaultNow()`), not by app code — a
  single-node Postgres has one clock, so there is no multi-node clock skew to
  reason about. Only a relay that re-stamps (`new Date()`) reintroduces skew.
- `sequence` is the **per-aggregate monotonic version**, the tiebreaker that makes
  §6B.5's stale-event check deterministic even when two events for one aggregate
  land in the same millisecond. Generate it **inside the same transaction** as
  `MAX(sequence)+1`, serialized with a **Postgres advisory transaction lock** on one
  **root aggregate key per transaction** (`pg_advisory_xact_lock`, `hashtextextended`
  over it) — instead of a row-level `SELECT … FOR UPDATE` on parent rows (R-S1),
  **and** instead of hashing each `aggregateId` the transaction touches (T1, §6C.4).
  The rule that kills the deadlock: **one key, chosen by domain, not by which rows
  the write touches** — `boardId` for every board write path, `workspaceId` for every
  membership write path. A multi-row outbox write (e.g. `acceptWorkspaceInvitation`
  emitting both `workspace.invitation.accepted` and `workspace.member.added`) locks
  `workspaceId` **once**; the sequence values for *all* rows in that tx flow from the
  one lock, so the ordering the stale-check needs still holds across rows. Advisory
  locks are acquired **one per transaction**, so they cannot form a lock-order cycle:
  the row-level variant deadlocks when concurrent transactions lock *multiple*
  aggregates in different orders, and even advisory locks deadlock if two
  transactions lock *different sets* of hashed keys in reverse order — which is why
  the key must be the single root, never a per-aggregate key. Serialization order =
  commit order, which is the ordering the stale-check needs. A bare global Postgres
  `SEQUENCE` (`nextval`) is NOT equivalent: it is ordered by *call* time, not *commit*
  time, so a concurrent transaction that calls `nextval` later but commits earlier can
  pair a lower counter with a newer state, and §6B.5's tuple check then discards a
  **valid** event. The commit sequence (WAL LSN) is a fine alternative if you prefer
  it to advisory locks.

### 6B.3 Outbox hooks (mechanical — same-transaction rule, all of them)

| Write path | File:line | Appended in `tx` | Refactor needed |
|---|---|---|---|
| Accept workspace invite (member insert at `:182`) | `workspace/invitations.ts:151` | `workspace.invitation.accepted` + `workspace.member.added` | none (already `db.transaction`) |
| Create workspace (owner insert at `:10`) | `workspace/core.ts:7` | `workspace.member.added` | none (already tx) |
| Delete workspace member | `workspace/core.ts:67` | `workspace.member.removed` | must also `SELECT userId` at `:68` (today only id + role) |
| Workspace role change (endpoint doesn't exist yet) | future `core.ts` fn | `workspace.member.role_changed` | **add the endpoint** (R4, §6C) |
| Create board | `board/lifecycle.ts:7` | `board.created` | wrap in `db.transaction` |
| Duplicate board (copy insert at `:30`) | `board/lifecycle.ts:22` | `board.created` | already tx |
| Delete board | `board/lifecycle.ts:49` | `board.deleted` | wrap in tx |
| Accept board invite (member insert at `:78`) | `board/invitation-transitions.ts:53` | `board.invitation.accepted` + `board.access.granted` | none (already tx) |
| Revoke board invite | `board/invitation-transitions.ts:125` | `board.invitation.revoked` | wrap in tx |
| Add / upsert board member | `board/members.ts:11` | `board.access.granted` (upsert semantics) | wrap in tx |
| Patch board member permission | `board/members.ts:24` | `board.access.permission_changed` | wrap in tx |
| Remove board member | `board/members.ts:31` | `board.access.revoked` | wrap in tx |
| Leave board | `board/members.ts:35` | `board.access.revoked` | wrap in tx |
| Toggle link share / rotate token | `board/sharing.ts:11`, `:31` | `board.link_share.updated` | wrap in tx |

The Phase 1 rule does not change: **the outbox append runs in the same transaction
as the write, never a second request.** The only new work is wrapping the
single-statement writers (`members.ts`, `sharing.ts`) in `db.transaction` — the same
test-mock churn already accepted in §6 Step 11.

### 6B.4 The projection (what a future consumer must compute)

A faithful, join-free port of `access.ts`. Four local tables per consumer:

```
p_board(id PK, workspaceId, exists ON current board)      ← board.created/deleted
p_workspace_member(memberId PK, workspaceId, userId, role) ← workspace.member.*
p_board_link_share(boardId PK, enabled, permission)        ← board.link_share.updated
p_board_access(boardId, userId, directPermission, inheritedPermission, effectivePermission,
               lastAppliedAt NOT NULL, lastAppliedSequence NOT NULL DEFAULT 0, PK (boardId, userId))  ← board.access.* + recompute
```

> The gauge columns are **NOT NULL** (T2, §6C.4): a legacy row with no prior outbox
> history must still answer the stale-check `(occurredAt, sequence)` tuple comparison.
> `NULL` on either side silently disables the guard in PostgreSQL (row-value comparison
> with a `NULL` member is unknown, not false). Default `lastAppliedSequence = 0` and
> `lastAppliedAt = '-infinity'` for un-watermarked rows; the §6B.5 upsert `COALESCE`s
> anyway as a second belt.

Decisions, exactly matching today's code:

1. Content check on the hot path = `p_board_access.effectivePermission` exists.
2. `inherited = workspaceRoleToBoardPermission(member.role)` — the monolith mapping
   is *"viewer → view, anything else → edit"* (`board.service.utils.ts:35`). This is
   the one piece of business logic that must ship in `packages/contracts` so it
   cannot drift from the monolith (R10, §6C).
3. `effective = max(direct, inherited)` — edit beats view; this is the additive rule
   at `access.ts:50-53`. A workspace viewer directly added as editor gets **edit**.
4. Manage-access (admin routes) reads `p_workspace_member.role`, **not** permission:
   `{owner, admin}` manage members / link-share / delete (`shared.ts:163,167`),
   `{owner, admin, editor}` create boards (`shared.ts:159`). Keep the role column —
   a single per-user permission can't answer this question.
5. Link-share is board-level and not per-user: enforced by the service that owns
   `boards` by token compare. `p_board_link_share` is for listing purposes only.
   The token itself never enters the event stream or descends into other services.

`workspace.member.role_changed` (and `.removed`) recompute `inheritedPermission` /
delete rows for **every board in the workspace** — one projection transaction,
scroll `p_board` by `workspaceId`. This is a genuine hot burst on workspace-heavy
tenants (a 10k-board workspace + a role change = 10k row updates in one consumer
tick, blocking the whole `access` partition behind it). Two responses — only one is
defensible:

- **Eager + indexed is the only valid retention path.** Do **not** derive effective
  permission lazily in the read query: computing `max(direct, role→permission)` in a
  `SELECT` puts CPU on the hot path (every board request) and defeats a B-tree index
  on `effectivePermission`. If you keep workspaces, store a pre-computed, **indexed
  `effectivePermission`** column and accept that a role change is a bounded,
  batched cascade (a background job with a concurrency cap, not one big
  transaction). Correctness of the hottest path is worth paying for in the
  background.
- **Delete the source (better, and what this project is doing):** after
  `workspace-removal.md` lands there are **no workspace roles to cascade at all**.
  Inheritance vanishes; `p_workspace_member` and every `workspace.member.*` event in
  §6B.1 die, and the projection collapses to `owner_id` + `board_members` (§6C.2).
  Removing the concept beats optimizing its consequences.

### 6B.5 Idempotency & ordering — write it down now

Everything here is at-least-once, so events must apply safely twice, in any replay
shape:

- **Duplicate protection:** idempotent upserts on the natural key — `(boardId, userId)`, `memberId`, `boardId`. `INSERT ... ON CONFLICT DO NOTHING` keyed on `eventId` alone is NOT enough: a stale replay (`granted`, old `occurredAt`) must not resurrect access that was later revoked.
- **Stale-event protection:** store a per-natural-key watermark and **skip** any
  event at or below it. Compare `(occurredAt, sequence)` as a tuple — never wall
  clock alone: the DB-assigned `occurredAt` (§6B.2) removes node clock skew, and the
  per-aggregate `sequence` removes same-millisecond ambiguity. An event is stale iff
  `(event.occurredAt, event.sequence) <= (lastAppliedAt, lastAppliedSequence)`.
  Combined with Kafka per-key ordering, this makes replay-after-revocation safe.
- **Guard every upsert with the tuple comparison — put it in the SQL** (R-S2,
  §6C.3). The stale-check above only protects you if the write *itself* refuses to
  regress a watermark. `INSERT ... ON CONFLICT ... DO UPDATE` without a `WHERE` will
  happily overwrite a newer row with older state — the exact race §6B.6's backfill
  must survive. Every projection write must be a **guarded upsert**, and the guard is
  the same tuple predicate the stale-check uses:

  ```sql
  INSERT INTO p_board_access (board_id, user_id, effective_permission,
                              last_applied_at, last_applied_sequence)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (board_id, user_id) DO UPDATE SET
      effective_permission   = EXCLUDED.effective_permission,
      last_applied_at        = EXCLUDED.last_applied_at,
      last_applied_sequence  = EXCLUDED.last_applied_sequence
  WHERE (COALESCE(EXCLUDED.last_applied_at, '-infinity'::timestamp),
         COALESCE(EXCLUDED.last_applied_sequence, 0))
      > (COALESCE(p_board_access.last_applied_at, '-infinity'::timestamp),
         COALESCE(p_board_access.last_applied_sequence, 0));
  ```

  **The `COALESCE` is mandatory, not defensive decoration** (T2, §6C.4): in
  PostgreSQL, comparing a *row value* with any `NULL` element evaluates to `NULL`
  (unknown), not `FALSE`, so a plain `WHERE (…) > (…)` silently drops the update when
  either side holds a `NULL`. That is exactly what a legacy/grandfathered row carries
  until its first live write: the §6B.6 backfill preserves source watermarks, and a
  pre-event row legitimately has no prior watermark. Belt and suspenders: make the
  columns `NOT NULL ... DEFAULT 0` / `DEFAULT '-infinity'` in the projection schema so
  `NULL` can never enter in the first place (§6B.2 schema already does this for
  `outbox.sequence`). Never rely on the bare tuple predicate alone.

  An older replay or a slower backfill matches the `WHERE`, skips the update, and the
  newer watermark keeps winning. Apply the same guard to every projection table —
  `p_workspace_member` (on `memberId`), `p_board_link_share` (on `boardId`), and the
  `EXISTS` flag on `p_board`. Without it, the backfill in §6B.6 is unsafe no matter
  how well you seed its watermarks.
- **Ordering contract (hard invariant):** the projection is only correct because the relay keys by `aggregateId` (§6 Step 7: `key: row.aggregateId`) and Kafka preserves per-key order. Changing the key or coalescing topics breaks revocations. Say this in interviews — it's the difference between "events in" and "a correct system".

### 6B.6 Grandfathering / backfill — required, not optional

Every existing member, invite, and board predates the event stream. Before any
consumer can trust a projection it must be backfilled:

1. Backfill job reads `board_members`, `workspace_members`, `boards`,
   `board_invitations`, `workspace_invitations` and inserts the projection rows as
   if it had consumed the events — **seeded with the source's own watermarks** (the
   `(occurredAt, sequence)` of the snapshot cut taken from the outbox table). Rows
   whose source predates the outbox carry **no watermark** — write `sequence = 0`,
   `occurredAt = '-infinity'` (never `NULL`) so the §6B.5 guard stays a strict tuple
   compare (T2). Any live event that lands mid-backfill then carries a newer
   watermark than the backfill rows, and §6B.5's **guarded upsert** (the `WHERE`
   tuple predicate) drops the older write instead of being overwritten out-of-order.
2. Only then start the live consumers (dual-write overlap kept short); the backfill
   cut and the live stream must not overlap blindly.
3. Keep a **reconciliation job** comparing monolith tables ↔ projection until both
   read and write paths have cut over — this covers the "two truths" window (R6).

---

## 6C. Adverse Review of the Plan Above — and the resolutions

An honest attacker looks for where the plan above breaks. Ten hits, with what the
plan now does about each:

| # | Critique (the attack) | Severity | Resolution (built into the plan) |
|---|---|---|---|
| R1 | "You bolted 'access' onto 'invitation'." Invitations are a *sub-domain* — pending membership. Grants also come from direct adds, workspace membership, role changes, link-share — none of which are invitations. An `invitations-api` that owns "membership projections" (old §7) is the distributed-monolith name game; access escapes that boundary on day one. | High | Boundary is `membership-api` (members + invitations + role changes), the producer of `access` + `invitations` facts. Old §7 rewritten (§6C.1). |
| R2 | The §6 Step 4 outbox can't route. It has no `topic`; the relay hard-codes `invitations`. Adding a second topic requires a schema change *before* any of this is durable. | High | Add `topic` + `occurredAt`, relay forwards them from the row (§6B.2). |
| R3 | Not all write paths are transactional. `members.ts` / `sharing.ts` would emit the outbox in a *second* query — a crash between the write and the append loses the event, which is exactly the failure the outbox exists to prevent. | High | Every hook row lists the wrap-in-`db.transaction` step. Test mocks (`test/board.service.test.ts`) must expose `.transaction` — the churn already accepted in §6 Step 11. |
| R4 | `workspace.member.role_changed` has no source today. `src/routes/workspaces.ts` has no role-change endpoint (only `DELETE` at `:94`), and `core.ts` has no such function. The most important evolution event is unwritable. | Medium | Add `PATCH /workspaces/:wid/members/:memberId` + a `changeMemberRole` service fn + the outbox append, or explicitly document "role changes unsupported". For an access projection it is *the* evolution path — add it. |
| R5 | Cascade deletes are event-less. Deleting a workspace cascades `board_members` + `workspace_members` (schema `workspaces.ts:15-17`) with no events; delete-workspace isn't implemented either. If added later without events, projections go stale *silently*. | Medium | Board delete emits `board.deleted` → projection purges by `boardId`. Future workspace delete must emit `workspace.member.removed` per member and `board.deleted` per board **in the same tx** (manual delete-all, never rely on cascade). |
| R6 | The projection is only as good as its inputs. One write path missing an outbox row produces a *plausibly wrong* watermark with no error. | Medium | Backfill + reconciliation job until cutover (§6B.6); consumer-lag and drift metrics in Phase 4. |
| R7 | Publishing `linkShareToken` to the stream would leak a capability (the token *is* the bearer auth) to unrelated consumers — audit, analytics. | High | **No *capability* ever rides the stream.** `board.link_share.updated` carries `enabled` + `permission` only; the token stays board-owned. Invitation tokens get the same treatment (§4 catalog now lists none, §6 Step 8): `.created` events carry only a write-time-minted short-lived signed claim, never the raw token and never a runtime fetch. Enforced at the outbox layer by payload builders, never a raw row dump. |
| R8 | Two permission axes were conflated even in the first draft of §6B. Storing one `permission` per user can't answer `canManageBoardAccess`. | Medium | Role vs permission stored in separate columns (`p_workspace_member.role`, `p_board_access.*Permission`) — §6B.4. |
| R9 | At-least-once × replay can double-insert *or* resurrect revoked access. EventId-dedupe alone is the naive fix and leaves the second bug. | High | Natural-key upserts **plus** a `(occurredAt, sequence)` watermark skipping stale events — §6B.5. |
| R10 | The projection reimplements `workspaceRoleToBoardPermission`; if the monolith later changes the mapping, stream and code diverge silently. | Low | Ship the mapping in `packages/contracts` (the only allowed shared code) so divergence is impossible. |

### 6C.1 Consequence: the §7 boundary is corrected

The earlier Phase 2 proposal — *"`invitations-api` owning invitations + membership
projections"* — is withdrawn. It was only viable because "membership projection"
did the real work under a misleading name. The corrected map:

- **`membership-api`** owns `workspace_members`, `board_members`, `workspace_invitations`,
  `board_invitations`. It is the *source of truth for who can do what* and the
  producer of the `invitations` **and** `access` topics. The "pending invites for a
  user" read model (old §7.2) is this service's projection to serve.
- **`boards-api`** owns `boards`, `elements`, and the link-share token. It consumes
  `access` into `p_board_access` and enforces content access locally. It **never**
  calls membership-api on the hot path.

Both depend only on `packages/contracts`. Gateway: `/api/invitations/*`,
`/api/workspaces/*/members*`, `/api/boards/*/members*` → membership-api;
`/api/boards/*` (content + enforcement) → boards-api.

### 6C.2 Round 2 — external review, adjudicated

A second-pass review attacked the plan above. Verdicts, honestly:

| # | Critic's claim | Severity | Ruling | Fix, and where it lives |
|---|---|---|---|---|
| A | The polling relay will bottleneck: `ORDER BY created_at` + row updates cause contention/bloat. | Valid (at scale) | **Accept.** CDC is overkill for Phase 1 (§6 Step 7 rebuts it) | `FOR UPDATE SKIP LOCKED` + keep the pending set small. §6 Step 7 |
| B | Kafka + RabbitMQ is over-engineered debt; the bridge is an extra failure vector. | Misguided as "fix", fair on ops | **Rebuff the kill, accept the option.** Kafka-for-log / Rabbit-for-work is the teaching point, but Rabbit is optional | Single-broker alternative: email as Kafka consumer group + DLQ. §6 Step 8 |
| C | `role_changed` recompute cascades → consumer-lag burst under big workspaces. | Valid | **Accept.** Blade decides: lazy-derive **or** delete the source | Lazy-derive stores `directPermission`+`workspaceRole`, effective at query time; deleting the source = workspace-removal. §6B.4 |
| D | Two events on two topics ⇒ no ordering between them (grant may precede lifecycle accepted). | Valid | **Accept as a hard rule** | Every multi-event publish must be self-contained; no consumer depends on cross-topic order. §6B.1 |
| E | Hybrid authz (projection reads + RPC manage) makes management a partial-outage risk if membership-api degrades. | Partially | **Accept the risk, shrink it.** After `workspace-removal.md`, `owner_id` is a **board column owned by boards-api** → manage-access becomes local too; membership RPC survives only pre-removal. Wrap that corner in a circuit breaker + fallback. §8.3 |
| F | `occurredAt` timestamps suffer clock skew. | Valid | **Accept** | `occurredAt` comes from the DB (`defaultNow()`), not app code. §6B.2 |
| G | Two events in the same millisecond → arbitrary order. | Valid | **Accept** | Per-aggregate `sequence` column; stale-check compares `(occurredAt, sequence)`. §6B.2/§6B.5 |
| H | Long-running dual-write → split-brain. | Valid | **Accept** | Bounded verification window; one write owner at a time; atomic flip gated by reconciliation. §7 Step 4 |

**The decisive simplification:** critiqued items C, E, and half of §6B's complexity
(all the `workspace.member.*` machinery, R4/R5/R8) exist **only because workspaces
exist**. The workspace-removal plan is not an alternative to this microservice plan —
it is the prerequisite that collapses the access problem into *one table*:
`boards.owner_id` + `board_members`. Read `workspace-removal.md` §12 **before**
building §6B. If that removal lands, this section's projection drops `p_workspace_member`,
four events, the recompute cascade, and the two-permission-axes answer entirely.

### 6C.3 Round 3 — external review, adjudicated

A third review attacked the round-2 plan. It was right about two things that matter,
half-right about a third, and wrong about one fix. Verdicts:

| # | Critic's claim | Severity | Ruling | Fix, and where it lives |
|---|---|---|---|---|
| R-S1 | The §6B.2 `MAX(sequence)+1` under a **row-level** `SELECT … FOR UPDATE` on the parent aggregate deadlocks under concurrency (imports + role changes locking overlapping boards in different orders). Proposes a global Postgres `SEQUENCE`. | Valid (problem), rejected (proposed fix) | **Accept the deadlock, rebuff the fix.** A one-lock-per-transaction **advisory xact lock** fixes it without Postgres erroring; a bare global `nextval` is ordered by *call*, not *commit*, so it can mis-pair a lower counter with newer state and the stale-check drops a valid event | Advisory `pg_advisory_xact_lock` on the aggregate id; keep `MAX(sequence)+1`. WAL LSN is an acceptable alternative. §6B.2 |
| R-S2 | Backfill (`§6B.6`) can overwrite newer live state: `.insert ... ON CONFLICT DO UPDATE` with no `WHERE` lets a slow backfill row (older watermark) clobber the live row (newer watermark), silently resurrecting stale access. | Valid | **Accept.** The stale-check was stated as policy but not wired into the SQL | Guard every projection upsert with `WHERE (EXCLUDED…) > (current…)` on the `(occurredAt, sequence)` tuple. §6B.5 |
| R-S3 | Token paradox: R7 forbids tokens in the stream, yet §6 Step 8 (as originally written) had the email worker reading tokens off the `invitations` topic to build the accept link — and §4's catalog still listed `token` in the `.created` payloads. | Valid | **Accept.** The catalog contradicted its own security rule | Tokens never ride the stream. Email worker gets a write-time-minted signed, expiring claim in the private payload; the two-broker variant keeps it in a private `notifications.email` queue only. §6 Step 8, §4, R7 |
| R-S4 | Workspace-removal (§6C.2's "decisive simplification") must be a **hard prerequisite (Phase 0)**, not advice — building §6B's workspace projection before the removal lands is throwaway work. | Valid | **Accept as ordering rule.** The removal is not a nice-to-have footnote | `workspace-removal.md` lands **first**; §6B's `workspace.member.*` machinery is built only if removal is rejected. §6C.2 / below |
| R-S5 | Workspace-member events should partition by `workspaceId`/`userId` to get per-tenant ordering, not by `memberId`. | Overreach | **Rebuff.** The projection's natural key *is* `memberId`/`(boardId, userId)`; per-member ordering — not per-tenant — is what the stale-check needs, and per-tenant partitioning would serialize unrelated members of a big workspace onto one partition | Keys stay as cataloged (§6B.1). Per-key ordering is per-aggregate; the cascade (§6B.4) scrolls by `workspaceId` in the consumer, it does not need Kafka ordering across member keys. |

**Dependency note (from R-S4).** Order of work becomes: (1) `workspace-removal.md`
decision, (2) §6B built for the *post-removal* model, (3) Phase-2 membership-api.
If the removal is accepted, §6B loses `p_workspace_member`, the four
`workspace.member.*` events, the recompute cascade, and the two-permission-axis
answer entirely — which is why Step-8's email worker and the guarded-upsert lesson
(§6B.5) are the durable parts of this phase; the workspace machinery is the contingent
part.

### 6C.4 Round 4 — external review, adjudicated

A fourth review ran the round-3 plan under high-concurrency production load and
found three edge cases. All three are accepted — none invents new machinery, each
tightens wording that a careless implementer would get wrong:

| # | Critic's claim | Severity | Ruling | Fix, and where it lives |
|---|---|---|---|---|
| T1 | Multi-aggregate advisory locks can still deadlock: `acceptWorkspaceInvitation` emits events for *two* aggregates (`workspace_invitation` + `workspace_member`) in one tx; if tx A locks invitation→workspace and tx B locks workspace→invitation, Postgres reports `deadlock detected`. | Valid | **Accept.** The fix is to stop hashing each `aggregateId` and lock **one root aggregate key per transaction**, chosen by domain | Lock `workspaceId` for every membership write, `boardId` for every board write — never per-aggregate keys, never multi-key per tx. §6B.2 |
| T2 | The guarded upsert's bare tuple comparison silently drops live updates when a watermark element is `NULL` (grandfathered rows with no prior outbox history): in Postgres, a row-value comparison with any `NULL` member yields `NULL` → the `WHERE` becomes unknown → the update is skipped. | Valid | **Accept.** `NULL` watermarks must be impossible by schema, and the guard must `COALESCE` defensively | `NOT NULL ... DEFAULT 0` (`-infinity` for timestamps) on every watermark column; `WHERE (COALESCE(...)) > (COALESCE(...))`. §6B.2 outbox schema, §6B.5 upsert SQL |
| T3 | The JIT HTTP fetch from the email worker back into membership-api (offered in §6 Step 8 as an alternative to a signed claim) turns an async consumer into a synchronous client: a slow/deploying membership-api stalls the email consumer, backs up the partition, and couples two scaling domains. | Valid | **Accept.** The signed claim must be the **only** mechanism, and it must be minted at write time so the worker never makes a network call | Outbox write mints the signed, expiring claim in the same transaction; worker verifies locally. JIT fetch removed. §6 Step 8 |

**What Round 4 did not change.** Broker topology (single Kafka + DLT), token
isolation, the watermarked-upsert pattern itself, and the Phase-0 sequencing all
survived without modification — the review confirmed them. The three accepted fixes
are refinements to *how* existing mechanisms are applied, not new components.

## 7. Phase 2 — membership-api, the corrected first microservice

Once events flow, extraction becomes safe.

1. **Ownership split.** Create `packages/membership-api` (Express + Zod + Drizzle)
   with its own Postgres schema owning `workspace_members`, `board_members`, and
   both invitation tables — or, after `workspace-removal.md`, just `board_members`
   + `board_invitations`. Invitations are a sub-resource here — *pending
   membership* — not a service of their own. Migrations live in the service, not
   the monolith. It is the producer of the `invitations` + `access` topics (its
   own outbox relay; during cutover the monolith still publishes and membership-api
   behaves as a write-through read model).
2. **Read model.** The "pending invites for a user" query
   (`src/services/board/pending-invites.ts`) and the "boards I can access" query
   (`listAccessibleBoards` in `board/queries.ts`) become projections built by
   consuming `invitations` + `access` events into the service's own tables. No
   cross-DB joins.
3. **Gateway.** nginx routes `/api/invitations/*`, `/api/workspaces/*/members*`,
   and `/api/boards/*/members*` to membership-api. The monolith stops serving those
   routes.
4. **Cutover.** Dual-write is a **bounded verification window, not a mode of
   operation**. There is exactly one write owner at every moment — first the
   monolith (membership-api is a read-only consumer of the events, exercising its
   projection), then, after the reconciliation job (§6B.6) reports zero drift for a
   full cycle, **one atomic flip** to membership-api as the write path. Never leave
   both writing simultaneously; a long dual-write is how split-brain happens (one
   side of a write fails, the other succeeds, and the tables diverge with no single
   source of truth to trust).
5. **Contracts package.** Move event/payload schemas, the `workspaceRoleToBoardPermission`
   mapping, and permission/role constants to `packages/contracts` with versioning
   (AsyncAPI spec). Both services depend on it; nothing else is shared.

---

## 8. Phase 3 — boards-api: content + local access enforcement

Now that membership owns the `access` feed, the board content service can be
extracted without dragging joins behind it.

1. **What moves.** `boards`, `elements`, `mutations`, `commits`, `preview_*`, and
   the link-share columns. `board_members` **stays in membership-api** — boards-api
   only ever sees `p_board_access`. This is where `board/` helpers that still touch
   `workspace_members` (e.g. `shared.ts:141 getWorkspaceRoleForBoard`) get deleted.
2. **Content enforcement.** `checkBoardAccess` (`access.ts`) is deleted and replaced
   by the §6B.4 projection spec: hot path = `p_board_access.effectivePermission`
   single-row lookup.
3. **Manage-access decisions** (add/remove member, link-share toggle, invite-create,
   delete) are the *non-hot* path — affordable to call membership-api over HTTP.
   Content reads stay local; membership RPC only on admin corners. Write this
   trade-off down: *"local projection for reads, RPC for rare privileged writes."*
   If the RPC corner stays, wrap it in a **circuit breaker with a deny-by-default
   fallback** (membership-api down ⇒ management ops fail closed, viewing unaffected)
   — and remember that after `workspace-removal.md` this corner disappears anyway,
   because `owner_id` is a board column and boards-api owns it (§6C.2).
4. **Preview job becomes event-driven.** The inline
   `void previewJobService.enqueue(...)` in `mutations.routes.ts:36` /
   `mutations.routes.ts:61` becomes boards-api publishing `board.updated`; the
   existing async worker (`src/index.ts:35`) consumes it. This closes the last
   in-process coupling and gives boards-api a real publisher role.
5. **Keep authn where it is.** Sessions (auth middleware) stay in one place during
   this phase; boards-api trusts an authenticated `userId` passed via the gateway.

## 9. Phase 4 — hardening the soft spots (cross-cutting)

With two services + async workers, the interesting failures are now distributed.
Close them deliberately:

- **Distributed tracing.** W3C `traceparent` propagated from nginx → membership-api /
  boards-api → Kafka consumer / RabbitMQ worker, so "why can't I open this board?"
  is traceable end-to-end instead of a spelunking exercise.
- **Projection health.** Per-topic consumer lag + a `p_board_access` staleness
  metric; the reconciliation job (R5/R6) promoted to an always-on canary for as long
  as dual-write exists.
- **Idempotency keys.** `Idempotency-Key` header on membership-api writes — turns
  client retries from data hazards into no-ops without relying on at-least-once
  heroics.
- **Security.** Link-share as a *signed, expiring capability* (JWT bound to boardId +
  permission + expiry) instead of a DB token compare — rotation = old signature
  invalid, no revocation round-trip. Service-to-service authn (mTLS or per-service
  keys at the gateway) before boards-api trusts "DELETE member" calls. Invitation and
  link-share tokens never logged, never in events (R7).
- **Sizing payoff.** Board reads are the hotspot; boards-api scales/shardes
  independently of membership-api. That independence — not the number of repos — is
  the point.

## 10. Resume / Interview Talking Points

- **Transactional outbox** for reliable event publishing — atomic with the write.
- **Event-driven architecture** with Kafka as system-of-record (replayable log) and
  — optionally — RabbitMQ for task queues; you can explain *why each broker*, *and*
  why Phase 1 defaults to a single broker and only reaches for RabbitMQ when a second
  work-queue consumer exists (§6 Step 8).
- **At-least-once delivery** handled with idempotent consumers and guarded
  watermarked upserts (stale replays can never resurrect revoked access — §6B.5).
- **Independent data ownership** and **read-model projection** for the extracted
  service (CQRS-flavored).
- Clean seam between transactional writes (monolith) and async consumers (workers) —
  the first step toward independent deployment.
- **Access as an event-driven projection**: permission reads stay local, grants are
  asynchronous — a CQRS answer for the hottest path, with the monolith's
  `checkBoardAccess` captured as the golden-master spec for the projection.
- **Two-permission-axes modeling** (content vs manage-access) and the discipline of
  storing *role* and *permission* as separate facts.
- **Adversarial review discipline**: the plan surfaced its own holes — outbox
  `topic` gap, a spec'd-but-unwritable `role_changed` event, cascade-delete
  blindness, a capability-leak risk, replay-resurrection, a sequence deadlock
  vector, and an unguarded-upsert backfill race — before a line of
  build code shipped (§6C).
- **Grandfathering**: backfill + reconciliation as the migration strategy that makes
  an event-driven extraction safe, not scary.

### Interview drill

"Your service writes an invite and publishes an event — what if it crashes in the
middle?" → *outbox: same transaction; relay publishes; at-least-once; consumer is
idempotent.*

"Kafka or RabbitMQ — which and why?" → *Kafka for the event log (replay, many
consumers, ordering by key). Email is work, so the classic answer is RabbitMQ (ack,
retry, DLQ) — but a work queue is only worth a second broker when there's real work
to do. Phase 1 keeps it honest: the email worker is a Kafka consumer group with a
dead-letter topic; RabbitMQ only appears when a second queue consumer grows in.*

"Your projection is at-least-once and the stream can replay — how do you not
double-apply or resurrect a revoked grant?" → *natural-key upserts guarded by a
`(occurredAt, sequence)` watermark in the `WHERE` clause; stale replays lose the
tuple comparison. The sequence comes from a per-aggregate counter taken under one
advisory lock per transaction, and `occurredAt` from the DB clock — so the watermark
reflects commit order and a replay can never regress the projection.*

"Why does membership deserve its own service?" → *distinct lifecycle (invite → grant
→ change → revoke), multiple independent consumers (notifications, access projection,
audit), and it can own its data — not because it's small.*
