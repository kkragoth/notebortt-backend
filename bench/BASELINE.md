# Performance Baseline

Generated: 2026-08-24T14:00:58.971Z
Commit: 329cfd3

## REST mutations (POST /api/v1/boards/:id/mutations)

- Throughput: **250 req/s**
- Latency p50/p95/p99: **78 / 84 / 131 ms**
- Connections: 20, duration: 10s

## Socket.IO frames (realtime:tick)

- Emit rate: **450 frames/s** (4500 emitted)
- Broadcast realtime:tick frames seen by observer socket: **4500** (~450/s)
- Rate: 500 frames/s burst refill every 1s

Regenerate with `UPDATE_BASELINE=true just bench`. The CI perf gate compares
against the rolling median of bench-history.json (last 10 runs); >10% p95
regression fails the nightly gate. PR runs are informational only.
