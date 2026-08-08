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
  **lifecycle events**, and let microservices consume them. Then extract the
  invitation **read model / write path** once the event stream exists.

Two-phase plan:

| Phase | What you build | What it teaches |
|---|---|---|
| **1 — Event backbone** | Outbox table + Kafka event log + RabbitMQ notification worker | The hard 70%: outbox pattern, at-least-once, event vs command, message brokers |
| **2 — invitations-api** | Real microservice: own DB, own migrations, own API, gateway routing | Data ownership, deployment independence, read-model projection |

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

### Kafka vs RabbitMQ — why both (this is the resume gold)

| | Kafka | RabbitMQ |
|---|---|---|
| Nature | Append-only **event log** | Message **broker / work queue** |
| Unit | Events on a partitioned topic, replayed from offsets | Messages consumed from a queue, acked per-message |
| Best for | "This happened" — many systems care, now or later (replay, audit, read models) | "Do this work" — one job, one worker, retries, DLQ |
| Guarantee | At-least-once per partition, ordering by key | At-least-once with manual ack; dead-letter exchanges |
| In this project | System of record for the invitation lifecycle | Task distribution for "send email" notifications |

**Rule of thumb to memorize:** *"Kafka for 'this happened', RabbitMQ for 'do this
work'."*

- Kafka is the source of truth stream. Any future service (audit, analytics,
  read-model) can consume `invitations` independently or replay it.
- RabbitMQ decouples the email task from the event log, so the worker can ack/retry
  per message without touching Kafka's history.

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
| `workspace.invitation.created` | monolith | email worker, invitations-api, audit | invitationId, workspaceId, invitedBy, recipientEmail, role, token, expiresAt |
| `workspace.invitation.accepted` | monolith | invitations-api, audit | invitationId, workspaceId, userId, recipientEmail, role |
| `workspace.invitation.declined` | monolith | invitations-api, audit | invitationId, workspaceId, recipientEmail |
| `workspace.invitation.revoked` | monolith | invitations-api, audit | invitationId, workspaceId, recipientEmail, revokedBy |
| `board.invitation.created` | monolith | email worker, invitations-api, audit | invitationId, boardId, invitedBy, recipientEmail, permission, token, expiresAt |
| `board.invitation.accepted` | monolith | invitations-api, audit | invitationId, boardId, userId, recipientEmail, permission |
| `board.invitation.declined` | monolith | invitations-api, audit | invitationId, boardId, recipientEmail |
| `board.invitation.revoked` | monolith | invitations-api, audit | invitationId, boardId, recipientEmail, revokedBy |

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
│   ├── invitations-api/      # Phase 2: THE microservice (own DB, own migrations)
│   └── notifications-worker/ # Phase 2: RabbitMQ consumer → email provider
├── src/                      # ← where you are now (Phase 1 stays here)
│   ├── events/               # Phase 1: outbox, relay, bridge, email worker
│   └── ...
└── docker-compose.yml
```

Ground rules (Phase 2):
- Each service: own Postgres **schema/DB**, own migrations, own Dockerfile, own
  `/health` endpoint.
- No shared ORM models across service boundaries; only `contracts` DTOs/events.
- nginx routes `/api/invitations/*` → invitations-api, everything else → core.

---

## 6. Phase 1 — Event Backbone (Build It)

> Where: current repo, in-process workers (like the existing
> `previewJobService.startWorker()` at `src/index.ts:35`). Nothing is deployed
> separately yet — but each worker is written as if it could be.

### Step 1 — Infrastructure

Add to `docker-compose.yml`:

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

### Step 8 — Bridge + email worker

**Bridge** (`src/events/bridge.ts`): a Kafka consumer group that reads `invitations`,
filters `*.created` events, and publishes a task to RabbitMQ queue
`notifications.email`.

**Email worker** (`src/events/email-worker.ts`): a RabbitMQ consumer on
`notifications.email`; for each message, log "would send invitation email to
<recipient>" and `ack()`. Swap the log for a real SMTP/transactional provider later.
On processing error, `nack` → RabbitMQ retries → eventually a dead-letter exchange.

Why the Kafka→Rabbit hop and not direct publish? Kafka keeps the full event history
(any consumer can replay). RabbitMQ carries the ephemeral *work*. If the email
worker crashes, its queue survives and messages aren't lost — and the event log is
untouched.

### Step 9 — Wire it up

`src/app/runtime.ts`: create relay, bridge, worker alongside the existing workers.
`src/index.ts`: start them (gated by `EVENT_BACKBONE_ENABLED`), mirroring:

```ts
const stopRelay = runtime.eventRelay.start()
const stopBridge = runtime.kafkaRabbitBridge.start()
const stopEmailWorker = runtime.emailWorker.start()
```

### Step 10 — Run it & verify

```bash
just db-migrate && just db-seed
just dev                      # brings up kafka + rabbitmq + backend
```

1. Hit the workspace invite endpoint (or run a seed script that creates an invite).
2. Watch the relay log: outbox row → Kafka.
3. Watch the bridge + email worker logs: `would send invitation email to ...`.
4. Check `SELECT * FROM outbox_events;` → rows flip pending → published.
5. Inspect UI: Kafka via `kcat -L -b localhost:9094` or a UI tool; RabbitMQ at
   `http://localhost:15672` (guest/guest).

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

## 7. Phase 2 — The Actual Microservice (Next)

Once events flow, extraction becomes safe.

1. **Ownership split.** Create `packages/invitations-api` (Express + Zod + Drizzle)
   with its own Postgres schema owning `invitations` (+ membership projections).
   Migrations live in the service, not the monolith.
2. **Read model.** The "pending invites for a user" query
   (`src/services/board/pending-invites.ts`) becomes a projection built by consuming
   `invitations` events into the service's own tables. No cross-DB joins.
3. **Gateway.** nginx routes `/api/invitations/*` to invitations-api. The monolith
   stops serving those routes.
4. **Cutover.** During migration, monolith writes invitation rows AND publishes
   events (dual-write); invitations-api reads from its projection. Flip reads first,
   then writes, then retire the old tables.
5. **Contracts package.** Move event/payload schemas to `packages/contracts` with
   versioning (AsyncAPI spec). Both services depend on it; nothing else is shared.

---

## 8. Resume / Interview Talking Points

- **Transactional outbox** for reliable event publishing — atomic with the write.
- **Event-driven architecture** with Kafka as system-of-record (replayable log) and
  RabbitMQ for task queues — and you can explain *why each broker*.
- **At-least-once delivery** handled with idempotent consumers.
- **Independent data ownership** and **read-model projection** for the extracted
  service (CQRS-flavored).
- Clean seam between transactional writes (monolith) and async consumers (workers) —
  the first step toward independent deployment.

### Interview drill

"Your service writes an invite and publishes an event — what if it crashes in the
middle?" → *outbox: same transaction; relay publishes; at-least-once; consumer is
idempotent.*

"Kafka or RabbitMQ?" → *Kafka for the event log (replay, many consumers, ordering by
key); RabbitMQ for work dispatch (ack, retry, DLQ). The email task is work; the
lifecycle is the log.*

"Why does invitation deserve its own service?" → *distinct lifecycle, multiple
independent consumers (notifications, audit, read model), and it can own its data —
not because it's small.*
