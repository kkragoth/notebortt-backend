# Metrics Migration — 24 Aug 2026 (P1)

The metrics exporter was rewritten from dynamic metric names + a folded
`tagset` label to a **fixed, pre-registered catalog** with static labels
(`src/platform/observability/metrics.ts`). Renames are breaking for existing
scrapers and dashboards.

> **Action required for monitoring owners:** migrate dashboards/record rules/
> alerts using the mapping below before or alongside the P1 rollout. Old
> series disappear on upgrade; new series exist from the first scrape
> (queue/DLQ gauges are pre-registered at zero).

## What changed

1. **No more `tagset` folding.** Labels are now declared per metric with
   static names (`category`, `command`, `event`, `queue`). Unknown label keys
   are stripped; unknown metric names are dropped (warn-once in logs).
2. **Cardinality is bounded by construction.** Label values come from
   code-level enums only. `boardId`/`userId` are never labels — board-level
   aggregates surface as global gauges instead.
3. **Per-app default-metric prefixes:** `api_*`, `realtime_*`, `worker_*`
   for node/process metrics (`api_nodejs_heap_size_used_bytes`, ...).
   Business metric names are identical across apps so one dashboard covers
   all three.
4. **New series** (see table): dirty-backlog + age, per-queue depth/oldest-age,
   DLQ depth, lock-acquisition histogram, Socket.IO RED set, BullMQ failure
   counter, DB pool stats, legacy/fragment usage counters (P3 gate inputs),
   domain-event enqueue failures (P2a).

## Rename mapping

| Old (dynamic/tagset)                          | New (catalog)                              | Type     |
|-----------------------------------------------|--------------------------------------------|----------|
| `redis.commands{tagset=...}`                  | `redis_commands_total{category,command}`   | counter  |
| `flush.duration_ms`                           | `flush_duration_ms`                        | summary  |
| `mutation.apply_change_set_ms`                | `mutation_apply_change_set_duration_ms`    | summary  |
| `mutation.process_batch_ms`                   | `mutation_process_batch_duration_ms`       | summary  |

Counters previously rendered as `<name>_total{tagset="k=v"}`; the tagset label
is gone — filter by the real labels instead (e.g.
`redis_commands_total{category="state",command="hmget"}`).

## New series to dashboard/alert

| Series                                        | Suggested use                                   |
|-----------------------------------------------|-------------------------------------------------|
| `board_dirty_backlog`                         | alert if > 0 for > 5 min (flush stalled)        |
| `board_dirty_age_max_seconds`                 | alert if > 3× persist interval (90s)            |
| `queue_depth{queue}` / `queue_oldest_age_seconds{queue}` | per-queue lag; alert on sustained growth (queues: board-persist-flush, board-maintenance, board-preview, plus P2a stubs) |
| `dlq_depth`                                   | always 0 until P2a; then alert > 0 (tolerate rolling-deploy transients) |
| `bullmq_jobs_failed_total{queue}`             | rate alert                                      |
| `mutation_lock_acquisition_duration_seconds`  | histogram; watch p99 vs 2s timeout (added P3)   |
| `socketio_client_events_total` / `_handler_errors_total` / `_handler_duration_seconds{event}` | RED per socket event |
| `socketio_connected_sockets`                  | replica load                                    |
| `db_pool_clients_active/idle`, `db_pool_max_connections` | pool saturation                       |
| `legacy_requests_total`                       | must be 0 for 14 days before P3 default flip    |
| `oauth_fragment_tokens_total`                 | same gate as above                              |
| `domain_events_enqueue_failed_total`          | populated from P2a; alert > 0 sustained         |

## Verification

`test/metrics.exporter.test.ts` locks the contract: catalog-only names,
label stripping (including `boardId` rejection), pre-registered queue/DLQ
series, collector execution at scrape time, and per-app prefixes.
