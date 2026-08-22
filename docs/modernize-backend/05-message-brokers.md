# Phase 4 — Message Brokers: RabbitMQ first, then Kafka

> Goal: move *work* off HTTP/websocket pods onto dedicated consumers, and create
> a durable event stream for future features — without rewriting domain logic.
> The phase-0 `EventBus` port and outbox table are the foundation; this phase
> only adds adapters.

## Inventory of async behavior today

| Flow | Current mechanism | Location | Classification |
|---|---|---|---|
| Preview rendering | ZSET `preview:jobs:due`, 90s debounce / 180s min-interval, Redis lock per board | `src/services/preview-job.service.ts` | **command** (delayed job) |
| Board state persistence | dirty-board age key polled by in-process worker (`DIRTY_BOARDS_BY_AGE_KEY`) | `services/board-persistence.service`, `board-state/keys.ts` | command-ish internal task |
| Redis cleanup | periodic in-process worker | `services/redis-cleanup.service` | scheduled maintenance |
| Live mutation fanout | Redis pub/sub `board:{id}:mutations` | `socketio/server.ts` | ephemeral event stream |
| Stripe webhooks | handled inline on HTTP route → DB writes | `services/billing/webhook-domain.ts` | **command** (needs retries) |

## Decision framework

| Need | Fit |
|---|---|
| Per-job ACK/retry/DLQ, routing, delayed execution, competing consumers | **RabbitMQ** |
| Durable ordered log, replay, multiple independent consumers, analytics/audit fan-out | **Kafka** |
| Sub-ms ephemeral fanout to live sockets | stay on Redis pub/sub |

Verdict: **RabbitMQ for commands/jobs now; Kafka for domain events when the
first replay/stream consumer exists.** Both sit behind the same `EventBus`
port where they overlap.

```
HTTP/WS pods ──publish──► RabbitMQ ──► worker deployment (preview, billing, persistence flush)
        │                                              ▲
        └── transactional outbox (Postgres) ──poller───┘──► Kafka topics ──► analytics / audit / future search
Redis pub/sub (live board fanout) stays as-is.
```

## Stage M1 — RabbitMQ adoption (commands)

### Topology (declarative, created at deploy)

| Entity | Name | Type | Notes |
|---|---|---|---|
| Exchange | `jobs` | topic | all commands published here |
| Queue | `jobs.preview.render` | quorum | binding `preview.render.#`; lazy mode |
| Delay mechanism | per-message TTL → dead-letter to `jobs.preview.render` | — | replaces 90s ZSET debounce; publisher sets `expiration` = remaining debounce |
| DLQ | `jobs.preview.render.dlq` | quorum | + alerting consumer |
| Queue | `jobs.billing.webhook` | quorum | binding `billing.webhook.#`; retry via TTL backoff queue ×3 then DLQ |

Quorum queues everywhere (replicated); no classic queues.

### Code changes (adapter only)

- New `RabbitMqEventBus implements EventBus` in `platform/events/`.
- `preview-job.service`: swap `zadd(PREVIEW_JOBS_DUE)` for
  `eventBus.publish({ type: 'preview.render', aggregateId: boardId, delayMs })`;
  consumer = extracted renderer (already isolated behind
  `BoardPreviewRenderer`). Lock key retained as second line of defense against
  duplicate delivery.
- Billing webhook route: verify signature inline (cheap), enqueue full payload,
  process in worker → idempotent via existing Stripe event IDs.
- Persistence flush + cleanup remain timer-driven inside workers deployment
  (no broker benefit yet).

### Consumer guarantees

- Idempotency: `consumer_inbox(consumer_group, event_id pk, processed_at)` table;
  handlers run inside `INSERT ... ON CONFLICT DO NOTHING` guard.
- Concurrency: `prefetch` tuned per consumer (preview: CPU-bound → prefetch 1–2).
- Poison messages: after 3 deliveries → DLQ + Prometheus alert
  `rabbitmq_queue_messages{queue=~".*dlq"} > 0`.

### Infra

- Staging/prod: managed (CloudAMQP) or RabbitMQ Cluster Operator on K8s
  (3-node quorum). Terraform module `rabbitmq` added alongside phase-2 modules.
- Local dev: add `rabbitmq:4-management` service to compose under profile
  `brokers` (off by default).

### Rollout & cutover gate

1. Dual-run: ZSET path remains source of truth; RabbitMQ path runs in shadow,
   outcomes logged & diffed (rendered hash equality) for ≥1 week.
2. Flip feature flag `PREVIEW_VIA_RABBIT=true` in staging → prod.
3. Delete ZSET code path one release later.
   Gate: 0 DLQ messages, p95 render latency ≤ current, zero double-renders
   observed over 7 days.

## Stage M2 — Kafka adoption (domain events)

Trigger condition (don't start earlier): a real need for replay or ≥2
independent consumers of the same event stream (e.g., audit log + search
indexer + notifications).

### Topics (single repo owns schemas initially)

| Topic | Key | Producers | Consumers |
|---|---|---|---|
| `note-canva.board.events.v1` | boardId | outbox dispatcher | audit, future search indexer |
| `note-canva.workspace.events.v1` | workspaceId | outbox dispatcher | notifications |
| `note-canva.billing.events.v1` | userId | outbox dispatcher | CRM/entitlement sync |

Schema evolution: JSON Schema files committed in `schemas/events/` validated in
CI (upgrade to Avro/Protobuf + Schema Registry only when a non-JVM/non-TS
consumer appears).

### Outbox → Kafka dispatch

Phase-0 `outbox_events` table is already populated transactionally. Dispatcher
(in workers deployment): poll unpublished rows → produce to topic keyed by
aggregate id → mark `published_at`. Ordering per aggregate guaranteed by key.
Upgrade path: replace poller with Debezium CDC if throughput demands.

Consumer groups scale horizontally on the existing `workers` Deployment until
volume justifies separate Deployments.

### Infra

- Managed first (MSK / Confluent Cloud / Upstash): operational cost of self-hosted
  Kafka is high; Strimzi on-cluster only if data-residency/cost forces it.
- Terraform module `kafka` (topic creation, IAM/scram creds into Secrets Manager
  → ESO).

## What deliberately does NOT move

- **Live CRDT mutation fanout** stays on Redis pub/sub: latency-sensitive,
  ephemeral by design; brokers would add ms-level hops for zero durability gain.
- **Presence writes** stay throttled direct-to-Redis.
- No request/response over brokers — HTTP API remains the synchronous surface.

## Monitoring baseline (both stages)

- RabbitMQ: queue depth, unacked, publish/deliver rates, DLQ gauge, connection count.
- Kafka: consumer lag (`kafka_consumergroup_lag`), ISR shrink alerts, produce error rate.
- App: `eventbus_publish_total{type}`, `eventbus_handler_duration_seconds`,
  inbox conflicts counter.

## Exit checklist

- [ ] Preview renders flow through RabbitMQ w/ TTL-delay + quorum queues + DLQ in prod
- [ ] Stripe webhook processing retried/DLQ'd, idempotent by Stripe event ID
- [ ] Outbox dispatcher publishing ≥3 event types to Kafka; lag < 10s sustained
- [ ] Runbook: DLQ drain procedure, broker failover drill completed
