# Elements Sync Architecture

## Goal

Drop database mutation tracking for board elements.

Store only:

- the current canonical element set in SQL
- the live collaborative board state in Redis
- a short-lived Redis change log for websocket catch-up

## Sync Modes

### Solo

Client uses `PATCH /boards/:boardId/elements` with:

```json
{
  "upserts": [{ "...": "element" }],
  "deletes": ["element-id"]
}
```

The server applies canonical changes to Redis immediately and a background worker flushes dirty boards to SQL.

### Multiplayer

Client still sends websocket mutations for interaction ergonomics.

Server flow:

1. Convert mutation into canonical element changes.
2. Expand deletes to all descendants.
3. Apply canonical changes to Redis.
4. Append the canonical change to the Redis change log.
5. Broadcast canonical `ELEMENTS_CHANGED` messages.
6. Flush dirty boards to SQL every minute and when rooms drain.

## Redis Responsibilities

Per board Redis keeps:

- `board:{id}:elements`: live element hash
- `board:{id}:seq`: monotonic board sequence
- `board:{id}:changes`: short-lived ordered change log
- `board:{id}:clients`: active websocket clients
- `board:{id}:seen:{mutationId}`: idempotency keys
- `boards:dirty`: boards needing SQL persistence

## SQL Responsibilities

SQL stores only the latest board snapshot in `elements`.

Current implementation rewrites the board element set during flush. If large boards make that too expensive, move to dirty-id upserts plus delete tombstones during flush.

## Delete Semantics

Server-side delete expansion is required.

If a user deletes:

- a column, all elements with `containerId = columnId` must also be deleted
- a meta column, all columns with `metaContainerId = metaColumnId` must also be deleted
- nested descendants, delete expansion continues recursively

This prevents orphaned notes from lingering in SQL after grid or meta-layout deletion.

## Undo / Redo

Undo and redo remain client-side.

The backend does not keep historical mutation rows. `Ctrl+Z` restores prior elements by sending normal upserts/deletes again.

## Catch-Up Strategy

When a websocket client joins:

1. If requested sequence is covered by the Redis change log, send `CATCH_UP`.
2. Otherwise send a full `SNAPSHOT`.

This keeps reconnects cheap while avoiding permanent mutation storage.

## Adverse Review

### Good

- Much lower write amplification than mutation-row persistence.
- SQL remains compact and query-friendly.
- Redis is a natural fit for active collaborative boards.
- Canonical change broadcast lets the server enforce cascade deletes and normalization.

### Risks

- Redis is not durable enough to be the only source of truth between flushes.
- Full-board SQL rewrites can become expensive on very large boards.
- A short Redis change log means some reconnects fall back to full snapshot.
- Without server-side delete expansion, nested elements become orphaned.
- Preview generation must tolerate delayed SQL flushes.

### Operational Guidance

- Keep periodic SQL flushes at around 60 seconds.
- Also flush when room size drops to `1`.
- Always flush before evicting a board from Redis when room size reaches `0`.
- Monitor dirty-board backlog and flush duration.
