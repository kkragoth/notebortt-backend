# Real-Time Socket.IO + Redis + SQL Persistence Tutorial

---

## High-Level Overview

This system is a **real-time collaborative whiteboard**. Multiple users can simultaneously edit a shared board — creating elements, moving them, resizing, deleting — with sub-second latency. The core challenge: how do you make writes fast (Redis speed) while guaranteeing durability (PostgreSQL)?

**Answer**: Redis is the fast path. PostgreSQL is the durable path. A background process bridges them.

---

### The Three Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                                │
│                                                                      │
│  Browser ──WebSocket──→ Socket.IO Client                             │
│  Browser ──WebSocket──→ Socket.IO Client                             │
│  Browser ──WebSocket──→ Socket.IO Client                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                        SERVER LAYER                                  │
│                                                                      │
│  ┌─────────────────┐    ┌─────────────────┐                         │
│  │  Socket.IO       │    │  Raw WebSocket   │  ← two transports     │
│  │  Server          │    │  Server          │    share Redis state   │
│  └────────┬────────┘    └────────┬────────┘                         │
│           │                      │                                   │
│           └──────────┬───────────┘                                   │
│                      │                                               │
│  ┌───────────────────▼───────────────────────────┐                  │
│  │          MutationProcessor                     │                  │
│  │  ┌─────────────┐  ┌──────────────┐            │                  │
│  │  │ Dedup Check │→│ Build Changeset│→ Apply     │                  │
│  │  │ (SET NX)    │  │ (per element) │  to Redis  │                  │
│  │  └─────────────┘  └──────────────┘            │                  │
│  └────────────────────────────────────────────────┘                  │
│                                                                      │
│  ┌───────────────────┐  ┌───────────────────┐                       │
│  │  TickCompactor    │  │  CrdtRoom (Yjs)   │  ← movement           │
│  │  (debounce+max)   │  │  (debounce+max)   │    compaction         │
│  └───────────────────┘  └───────────────────┘                       │
│                                                                      │
│  ┌───────────────────────────────────────────┐                      │
│  │  Background Workers                        │                      │
│  │  • BoardPersistenceService (30s)           │                      │
│  │  • RedisCleanupService (2min)              │                      │
│  │  • CompactionService (10min)               │                      │
│  └───────────────────────────────────────────┘                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────────┐
│                         DATA LAYER                                   │
│                                                                      │
│  ┌─────────────────────────┐      ┌─────────────────────────┐       │
│  │       REDIS              │      │      POSTGRESQL          │       │
│  │                          │      │                          │       │
│  │  • elements (HASH)       │ ←──→ │  • elements (TABLE)      │       │
│  │  • seq (STRING)          │ flush│  • boards (TABLE)        │       │
│  │  • changes (LIST)        │      │  • mutations (TABLE)     │       │
│  │  • dirty_* (SETs)        │      │                          │       │
│  │  • dirty_by_age (ZSET)   │      │                          │       │
│  │  • pub/sub channels      │      │                          │       │
│  │  • locks (SET NX)        │      │                          │       │
│  └─────────────────────────┘      └─────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────┘
```

---

### Data Flow: How a Mutation Travels

```
  USER DRAGS ELEMENT
        │
        ▼
  ┌─ Socket.IO Server ──────────────────────────────────────────────┐
  │                                                                  │
  │  1. Receive realtime:tick event                                  │
  │     │                                                            │
  │     ├─→ Broadcast cursor/presence to other LOCAL clients         │
  │     │   (io.to(boardId).emit)                                    │
  │     │                                                            │
  │     └─→ Queue moves in TickCompactor                             │
  │         │                                                        │
  │         │   ┌──────────────────────────────┐                     │
  │         └──→│ Map<elementId, position>     │                     │
  │             │ Overwrites = COMPACTION       │                     │
  │             │ (100 moves → 1 per element)   │                     │
  │             └──────────┬───────────────────┘                     │
  │                        │                                         │
  │              400ms debounce / 1500ms max-wait                    │
  │                        │                                         │
  │                        ▼                                         │
  │  2. FlushTickMoves() → build single MOVE_ELEMENTS mutation       │
  │     │                                                            │
  │     ▼                                                            │
  │  3. MutationProcessor.processBatch()                             │
  │     │                                                            │
  │     ├─→ Dedup check: SET NX board:{id}:seen:{mutationId}        │
  │     │   (300s TTL, prevents double-apply)                        │
  │     │                                                            │
  │     ├─→ Build change set: { upserts: [...], deletes: [...] }     │
  │     │                                                            │
  │     └─→ applyChangeSet() → Redis pipeline                        │
  │         │                                                        │
  │         ├─→ INCR  board:{id}:seq          (sequence number)      │
  │         ├─→ HSET  board:{id}:elements     (update position)      │
  │         ├─→ RPUSH board:{id}:changes      (change log, collab)   │
  │         ├─→ SADD  boards:dirty            (global dirty index)   │
  │         ├─→ SADD  board:{id}:dirty_element_ids                   │
  │         ├─→ INCR  board:{id}:dirty_epoch  (optimistic conc.)     │
  │         └─→ SET   board:{id}:last_active                         │
  │                                                                  │
  │  4. Publish to Redis pub/sub                                     │
  │     │                                                            │
  │     └─→ PUBLISH board:{id}:mutations                             │
  │         │                                                        │
  │         │   ┌─────────────────────────────────┐                  │
  │         └──→│ Other server instances subscribe │                  │
  │             │ → forward to their local clients │                  │
  │             └─────────────────────────────────┘                  │
  └──────────────────────────────────────────────────────────────────┘


  ┌─ Background: BoardPersistenceService (every 30s) ──────────────┐
  │                                                                  │
  │  1. ZRANGEBYSCORE boards:dirty_by_age → boards dirty >= 30s      │
  │     │                                                            │
  │     ▼                                                            │
  │  2. For each dirty board:                                        │
  │     │                                                            │
  │     ├─→ SMEMBERS board:{id}:dirty_element_ids                    │
  │     ├─→ HMGET    board:{id}:elements (current state)             │
  │     │                                                            │
  │     ├─→ SQL: INSERT ... ON CONFLICT DO UPDATE (upsert)           │
  │     ├─→ SQL: DELETE WHERE id IN (...deleted)                     │
  │     │                                                            │
  │     └─→ Lua script: verify dirty_epoch → clear dirty state       │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘


  ┌─ Background: RedisCleanupService (every 2min) ─────────────────┐
  │                                                                  │
  │  1. Find boards idle > 3 min with 0 clients                      │
  │  2. persistBoard() → flush to SQL                                │
  │  3. flushBoard() → SCAN + DEL all board:*:keys                   │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```

---

### Cross-Instance Communication

```
  ┌──────────────────────┐          ┌──────────────────────┐
  │   Server Instance A  │          │   Server Instance B  │
  │                      │          │                      │
  │  Client connects     │          │  Client connects     │
  │  to board "abc"      │          │  to board "abc"      │
  │         │            │          │         │            │
  │         ▼            │          │         ▼            │
  │  SUBSCRIBE           │          │  SUBSCRIBE           │
  │  board:abc:mutations │          │  board:abc:mutations │
  │         │            │          │         │            │
  │  Client sends        │          │                      │
  │  mutation            │          │                      │
  │         │            │          │                      │
  │         ▼            │          │                      │
  │  Apply to Redis      │          │                      │
  │         │            │          │                      │
  │         ▼            │          │                      │
  │  PUBLISH             │    →     │  SUBSCRIBE receives  │
  │  board:abc:mutations │          │  message             │
  │                      │          │         │            │
  │  io.to(abc).emit     │          │         ▼            │
  │  (local Socket.IO)   │          │  broadcast to local  │
  │                      │          │  WS + Socket.IO      │
  │                      │          │  clients on board     │
  └──────────────────────┘          └──────────────────────┘

  Note: No Socket.IO Redis adapter. Custom pub/sub channel per board.
  senderConnectionId prefixes distinguish sources: "socketio:" vs bare UUID.
```

---

### The Compaction Problem & Solution

```
  PROBLEM: User drags element for 2 seconds. 200 position updates arrive.

  WITHOUT compaction:
  ┌──────────────────────────────────────────────────────────────┐
  │  write 200 positions to Redis   → 200 HSET operations       │
  │  write 200 positions to change log                           │
  │  flush 200 dirty elements to SQL  → 200 UPSERTS             │
  │  broadcast 200 mutations to other clients                    │
  └──────────────────────────────────────────────────────────────┘

  WITH compaction:
  ┌──────────────────────────────────────────────────────────────┐
  │  Queue 200 positions in Map<elementId, position>             │
  │  Map overwrites: element "A" at (1,2), (3,4), ..., (199,200)│
  │  After 400ms debounce (or 1500ms max-wait):                  │
  │                                                              │
  │  Flush 1 position per element to Redis  → N HSET ops        │
  │  Flush 1 dirty element ID per element   → N SMEMBERS        │
  │  Flush 1 change to change log                                │
  │  Broadcast 1 mutation per element to other clients           │
  │                                                              │
  │  Result: 200 writes → 1 write per element (typically 1-3)   │
  └──────────────────────────────────────────────────────────────┘

  MECHANISM:
  ┌──────────────────────────────────────────────────────────────┐
  │  queueMoves(boardId, userId, [{id:"A", x:3, y:4}])          │
  │      │                                                       │
  │      ▼                                                       │
  │  pendingMoves.set("A", {x:3, y:4})  ← OVERWRITES previous   │
  │      │                                                       │
  │      ├── Debounce timer RESET (400ms from now)               │
  │      └── Max-wait timer SET (1500ms, only once)              │
  │                                                              │
  │  When either timer fires:                                    │
  │      │                                                       │
  │      ▼                                                       │
  │  moves = Array.from(pendingMoves)  ← only latest per element│
  │  mutation = { type: MOVE_ELEMENTS, moves }                   │
  │  processBatch([mutation])  ← single mutation batch           │
  └──────────────────────────────────────────────────────────────┘
```

---

### Solo vs Collaborative Mode

```
  ┌──────────────────────────────────────────────────────────────┐
  │                    SOLO MODE (1 user)                        │
  │                                                              │
  │  User edits → Redis write → SQL write IMMEDIATELY            │
  │                                                              │
  │  • No change log tracking                                    │
  │  • No deferred flushing                                      │
  │  • Fastest path: mutation → Redis → SQL in same request      │
  └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────┐
  │                  COLLAB MODE (2+ users)                      │
  │                                                              │
  │  User edits → Redis write → change log tracked               │
  │                           → SQL write DEFERRED (30s)         │
  │                                                              │
  │  • Change log maintained for catch-up sync on reconnect      │
  │  • Dirty boards flushed by background worker every 30s       │
  │  • Only boards dirty >= 30s are flushed                      │
  │  • 90s cooldown after last collaborator leaves               │
  │                                                              │
  │  Decision: getSyncWriteMode() checks:                        │
  │    - collab_mode_until key still valid? → 'collab'           │
  │    - clientCount >= 2 or viewerCount >= 2? → 'collab'        │
  │    - otherwise → 'solo'                                      │
  └──────────────────────────────────────────────────────────────┘
```

---

### Reconnect & Catch-Up Sync

```
  CLIENT DISCONNECTS              CLIENT RECONNECTS
        │                               │
        │                               ▼
        │                    Client sends lastSequence: 42
        │                               │
        │                               ▼
        │                    Server reads board:{id}:changes LIST
        │                    (capped at 2000 entries)
        │                               │
        │                    ┌──────────┴──────────┐
        │                    │                     │
        │              Log complete?          Log incomplete
        │              (first change           (was trimmed)
        │               seq == 43)             or empty
        │                    │                     │
        │                    ▼                     ▼
        │              Send CATCH_UP          Send SNAPSHOT
        │              (changes seq 43+)      (full element state)
        │                    │                     │
        └────────────────────┴─────────────────────┘

  Catch-up check in getChangesAfter():
    complete = changes[0]?.sequence === afterSequence + 1
    If the first change's sequence matches expected → log is continuous
    If not → log was trimmed, can't catch up → send full snapshot
```

---

### Redis Key Space Overview

```
  ┌───────────────────────────────────────────────────────────────┐
  │                     GLOBAL KEYS                               │
  ├───────────────────────────────────────────────────────────────┤
  │  boards:dirty          SET      boards with pending SQL       │
  │  boards:dirty_by_age   ZSET     dirty boards by timestamp     │
  │  boards:active         SET      boards with recent activity   │
  └───────────────────────────────────────────────────────────────┘

  ┌───────────────────────────────────────────────────────────────┐
  │               PER-BOARD KEYS  board:{id}:*                    │
  ├───────────────────────────────────────────────────────────────┤
  │  :elements              HASH     element_id → JSON             │
  │  :seq                   STRING   monotonic counter             │
  │  :changes               LIST     change log (max 2000)         │
  │  :dirty_element_ids     SET      elements pending SQL flush    │
  │  :deleted_element_ids   SET      elements pending SQL delete   │
  │  :dirty_since           STRING   first dirty timestamp         │
  │  :dirty_epoch           STRING   optimistic concurrency       │
  │  :seen:{mutationId}     STRING   dedup (300s TTL)              │
  │  :last_active           STRING   last activity timestamp       │
  │  :clients               SET      userId:connectionId           │
  │  :client_lease:{m}      STRING   lease (90s TTL)               │
  │  :viewer_sessions       ZSET     sessionId → timestamp         │
  │  :collab_mode_until     STRING   collab cooldown (90s TTL)     │
  │  :load_lock             STRING   load lock (30s TTL)           │
  │  :eviction_lock         STRING   eviction lock (30s TTL)       │
  │  :mutation_lock         STRING   mutation lock (30s TTL)       │
  │  :last_flushed_seq      STRING   last SQL flush sequence       │
  │  :last_flushed_at       STRING   last SQL flush timestamp      │
  │  :last_flush_duration_ms STRING  last flush duration           │
  └───────────────────────────────────────────────────────────────┘
```

---

### Lifecycle of a Board

```
  BOARD CREATED
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  1. First client connects                                    │
  │     loadBoard() → SELECT from PostgreSQL → HSET to Redis     │
  │     Redis keys created: :seq, :elements, :clients, etc.      │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  2. Active editing                                           │
  │     • Mutations applied to Redis immediately                 │
  │     • Change log tracked (if collab mode)                    │
  │     • Dirty elements tracked for SQL flush                   │
  │     • Background worker flushes to SQL every 30s             │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  3. Last client disconnects                                  │
  │     • persistBoard() → flush to SQL immediately              │
  │     • 30s grace period (scheduleRoomFlush)                   │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  4. Grace period expires, no one reconnects                  │
  │     • flushBoard() → SCAN + DEL all board:*:keys             │
  │     • Remove from boards:dirty, boards:active                │
  │     • Board no longer in Redis (will reload on next access)  │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  5. Idle for > 3 min, no clients (RedisCleanupService)       │
  │     • persistBoard() → final SQL flush                       │
  │     • flushBoard() → evict from Redis                        │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  6. Idle for > 1 hour (CompactionService)                    │
  │     • DELETE old mutation audit rows from PostgreSQL          │
  └──────────────────────────────────────────────────────────────┘
```

---

### The Optimistic Concurrency Problem

```
  WHY dirty_epoch EXISTS:

  1. Server A reads dirty_epoch = 5, starts SQL flush
  2. Server B processes a mutation, increments dirty_epoch → 6
  3. Server A finishes SQL write
  4. Server A runs Lua cleanup script:
     │
     │  if currentEpoch(6) != expectedEpoch(5):
     │      return 0  ← FLUSH SKIPPED
     │
  5. Dirty state preserved → next flush cycle will pick it up

  WITHOUT dirty_epoch:
  1. Server A reads dirty_elements = {X, Y, Z}
  2. Server B updates element X, adds X to dirty_elements
  3. Server A flushes {X, Y, Z} to SQL
  4. Server A clears dirty_elements → X's new state is LOST

  WITH dirty_epoch:
  1. Server A reads dirty_epoch = 5
  2. Server B updates X, increments dirty_epoch → 6
  3. Server A flushes (old state of X) to SQL
  4. Server A Lua check: 6 != 5 → skip cleanup
  5. dirty_elements still has X → next flush picks up B's version
```

---

## 1. Socket.IO Server Setup

### Server Creation (`src/socketio/server.ts:33-44`)

```typescript
const io = new Server(httpServer, {
  transports: ['websocket'],           // no long-polling fallback
  cors: {
    origin: parseAllowedOrigins(options.corsOrigin),
    credentials: true,
  },
})
```

WebSocket-only transport is enforced. CORS origins come from a comma-separated env var, parsed by `parseAllowedOrigins()` at line 29.

### Per-Connection State (`src/socketio/server.ts:79-165`)

Every socket connection tracks:

```typescript
let boardContext: SocketBoardContext | null = null   // which board + permission
let boardContextVersion = 0                          // incremented on each join
let identity: SocketIdentity | null = null           // resolved JWT user
let lastTickId = -1                                  // monotonic tick dedup
let latestJoinAttempt = 0                            // prevents stale join race conditions
const lastActivityWriteAtBySocketId = new Map()      // throttled presence writes
const activityJitterBySocketId = new Map()           // randomized throttle window
```

**`setBoardContext()` (line 93)** increments `boardContextVersion` and resets `lastTickId`. This version counter is used by `isSnapshotActive()` to detect if a handler's context snapshot is still valid (prevents acting on stale state after a board switch).

**`shouldWriteActivity()` (line 151)** implements jittered throttling:
```typescript
const jitter = Math.floor(Math.random() * (DEFAULT_ACTIVITY_WRITE_JITTER_MS + 1))  // 0-400ms
const effectiveWindow = Math.max(0, DEFAULT_ACTIVITY_WRITE_THROTTLE_MS + jitter)    // 3000-3400ms
```
This prevents thundering herd on Redis when many clients send presence simultaneously.

**`takeContextSnapshot()` (line 103)** captures a point-in-time snapshot of the connection's state. Handlers use this to verify the connection is still on the correct board before applying mutations:

```typescript
function takeContextSnapshot(expectedBoardId?: string): ContextSnapshot | null {
  if (!boardContext) return null
  if (expectedBoardId && boardContext.boardId !== expectedBoardId) return null
  return { context: boardContext, version: boardContextVersion }
}
```

### Event Handler Registration (`src/socketio/server.ts:233-257`)

All handlers are wrapped in `registerHandler()` which catches unhandled errors and emits `sync:error` to the client:

```typescript
registerHandler('board:join', createBoardJoinHandler(runtime))
registerHandler('mutation:batch', createMutationBatchHandler(runtime))
registerHandler('crdt:update', createCrdtUpdateHandler(runtime))
registerHandler('presence:update', createPresenceUpdateHandler(runtime))
registerHandler('realtime:tick', createRealtimeTickHandler(runtime))
registerHandler('disconnect', createDisconnectHandler(runtime, cleanupConnectionState))
```

The `runtime` object (line 212-231) bundles all dependencies into a single interface that handlers receive. This is the dependency injection pattern — handlers don't import singletons, they receive everything through `runtime`.

---

## 2. Board Join Flow (`src/socketio/handlers/join.handler.ts`)

### Step-by-step:

1. **Parse + validate** (line 8): `parseBoardJoinPayload(rawPayload)` uses Zod schema validation.

2. **Resolve identity** (line 15): If not already cached, calls `resolveSocketIdentity()` which reads JWT from cookies/bearer token.

3. **Check access** (line 23): `boardService.checkBoardAccess(boardId, userId, shareToken)` returns `{ hasAccess, permission }`.

4. **Detach previous board** (line 32-37): If the socket was already on a different board, detach from it first (removes from Redis client set, broadcasts USER_LEFT).

5. **Lazy-load board** (line 39): `boardStateService.loadBoard(boardId)` — loads from PostgreSQL into Redis if not already cached.

6. **Track client** (line 43): `trackClient()` adds `userId:connectionId` to Redis SET `board:{id}:clients` and sets a 90s lease key.

7. **Touch viewer session** (line 47): `touchViewerSession()` updates the sorted set `board:{id}:viewer_sessions` with current timestamp.

8. **Join Socket.IO room** (line 52): `socket.join(boardId)` — enables `io.to(boardId).emit()` for this socket.

9. **Notify others** (lines 64-86): Sends `USER_JOINED` to existing participants and broadcasts to room.

10. **Send snapshot** (line 88-97): `boardStateService.getSnapshot()` reads all elements + sequence from Redis.

### Lazy Load Mechanism (`src/services/board-state/load-domain.ts:99-152`)

`loadBoard()` uses a distributed lock pattern:

```
1. Check if board already in Redis (seq key exists)
2. If not, acquire load_lock (SET NX PX 30000)
3. Double-check seq key (another instance may have loaded it)
4. SELECT all elements from PostgreSQL
5. Pipeline HSET all elements into Redis
6. SET seq = 0
7. Release load_lock
```

The `waitForBoardLoad()` function (line 51) polls until the board is loaded:
```typescript
while (true) {
  const [loadLockExists, seqExists, evictionLockExists] = await Promise.all([
    redis.exists(loadLockKey),
    redis.exists(seqKey),
    redis.exists(evictionLockKey),
  ])
  if (evictionLockExists === 0 && (seqExists === 1 || loadLockExists === 0)) {
    return  // board is loaded and not being evicted
  }
  await sleep(25)  // poll every 25ms
}
```

---

## 3. Mutation Processing Pipeline

### 3a. MutationBatchHandler (`src/socketio/handlers/mutation-batch.handler.ts`)

Full flow for a single mutation batch:

```typescript
// 1. Validate payload
const payload = parseMutationBatchPayload(rawPayload)

// 2. Take context snapshot (captures board + version)
const snapshot = runtime.takeContextSnapshot(payload.boardId)

// 3. Permission check
if (snapshot.context.permission !== 'edit') → error

// 4. Refresh activity (throttled presence write)
await runtime.refreshSocketActivity(snapshot)

// 5. Verify snapshot still active (didn't switch boards mid-handler)
if (!runtime.isSnapshotActive(snapshot)) return

// 6. Process batch through mutation processor
const results = await runtime.deps.mutationProcessor.processBatch(
  payload.mutations,
  snapshot.context.userId
)

// 7. For each result:
for (const result of results) {
  // Ack to sender
  acknowledgedIds.push(result.mutationId)
  latestSequence = result.sequence

  // Broadcast to other LOCAL Socket.IO clients
  if (result.status !== 'already_applied') {
    runtime.socket.to(payload.boardId).emit('mutation', { mutation })
  }

  // Publish to Redis pub/sub for OTHER SERVER INSTANCES
  if (result.status === 'applied' && result.change) {
    await runtime.publishElementsChanged(boardId, userId, result.change, socketId)
  }
}

// 8. Send ack to sender
runtime.socket.emit('mutation:ack', { mutationIds, sequence })
```

### 3b. MutationProcessor (`src/mutations/processor.ts`)

#### `processBatch()` (line 252-298)

The batch processor groups mutations by board and acquires per-board locks:

```typescript
async function processBatch(mutations: Mutation[], userId: string) {
  // 1. Group by boardId
  const byBoard = new Map<string, Array<{ index, mutation }>>()
  for (let index = 0; index < mutations.length; index++) {
    const boardMutations = byBoard.get(mutation.boardId) ?? []
    boardMutations.push({ index, mutation })
    byBoard.set(mutation.boardId, boardMutations)
  }

  // 2. Process each board's mutations sequentially under lock
  for (const [boardId, boardMutations] of byBoard) {
    await withBoardMutationLock(boardId, async () => {
      // Shared cache for this batch — avoids re-reading from Redis per mutation
      const context = await createCachedBoardContext(boardId, mutations)
      const writeMode = await boardStateService.getSyncWriteMode(boardId)

      let shouldPersistSolo = false
      for (const entry of boardMutations) {
        const { result, appliedCanonicalChange } = await processMutationWithContext(
          entry.mutation, userId, context, writeMode
        )
        // Update cache so next mutation sees this mutation's effects
        applyPersistedChangeToContext(context, result)
        if (writeMode === 'solo' && appliedCanonicalChange) {
          shouldPersistSolo = true
        }
        results[entry.index] = result
      }

      // Solo mode: persist immediately after batch
      if (writeMode === 'solo' && shouldPersistSolo) {
        await boardStateService.persistBoard(boardId)
      }
    })
  }
}
```

**Key insight**: The `CachedBoardContext` is shared across mutations in the same batch. After each mutation is applied, `applyPersistedChangeToContext()` updates the cache so the next mutation sees the result. This avoids redundant Redis reads within a batch.

#### `processMutationWithContext()` (line 187-237)

Per-mutation processing:

```typescript
async function processMutationWithContext(mutation, userId, context, writeMode) {
  // 1. Skip transient moves (drag previews — broadcast only, no persistence)
  if (operation.type === MOVE_ELEMENTS && operation.transient) {
    return { result: { status: 'broadcast_only' }, appliedCanonicalChange: false }
  }

  // 2. Deduplication via Redis SET NX
  const claimed = await boardStateService.tryMarkSeen(boardId, mutationId)
  if (!claimed) {
    return { result: { status: 'already_applied' }, appliedCanonicalChange: false }
  }

  // 3. Convert operation to change set (upserts + deletes)
  const changeSet = toChangeSet(context, operation)

  // 4. Apply to Redis state
  const persistedChange = await boardStateService.applyChangeSet(boardId, changeSet, {
    trackChangeLog: writeMode === 'collab',
  })

  return { result: { status: 'applied', change: persistedChange }, appliedCanonicalChange: true }
}
```

#### Deduplication (`src/services/board-state/state-domain.ts:99-103`)

```typescript
async function tryMarkSeen(boardId: string, mutationId: string): Promise<boolean> {
  const result = await redis.set(
    boardSeenKey(boardId, mutationId),  // board:{id}:seen:{mutationId}
    '1',
    'EX', SEEN_TTL_SECONDS,            // 300 second TTL
    'NX'                                // only set if not exists
  )
  return result === 'OK'  // true = we claimed it, false = already seen
}
```

This prevents the same mutation from being applied twice (e.g., from both Socket.IO and WS transports, or from a retry).

#### `toChangeSet()` — Operation to Redis Write (`src/mutations/processor.ts:67-129`)

Converts each mutation type into `{ upserts: BoardElement[], deletes: string[] }`:

| MutationType | Transform |
|---|---|
| `CREATE_ELEMENT` | `{ upserts: [operation.data], deletes: [] }` |
| `UPDATE_ELEMENT` | Merge `operation.fields` into existing element from cache |
| `DELETE_ELEMENTS` | `{ upserts: [], deletes: operation.elementIds }` |
| `MOVE_ELEMENTS` | Update x,y on each element from cache |
| `UPDATE_ELEMENTS` | Merge fields for each element from cache |
| `REORDER_ELEMENT` | Update zIndex on element from cache |

The key function `toUpsertFromCache()` (line 54) reads the element from the in-memory cache (not Redis) and applies the transform:

```typescript
function toUpsertFromCache(elementsById, elementId, transform) {
  const existing = elementsById.get(elementId)
  if (!existing) return []
  return [transform(existing)]
}
```

#### `createCachedBoardContext()` — Targeted Reads (`src/mutations/processor.ts:150-173`)

Instead of reading ALL board elements, only the touched ones are fetched:

```typescript
async function createCachedBoardContext(boardId, mutations) {
  const touchedElementIds = collectTouchedElementIds(mutations)
  // Uses Redis HMGET for batch read of only needed elements
  const existingElements = await boardStateService.getElementsByIds(boardId, touchedElementIds)
  return { elementsById: new Map(existingElements) }
}
```

---

## 4. Redis State Domain (`src/services/board-state/state-domain.ts`)

### `applyChangeSet()` — The Core Write Path (line 110-186)

This is the most important function. It atomically updates Redis state:

```typescript
async function applyChangeSet(boardId, changeSet, options) {
  // 1. Collect cascade deletes (deleting a container deletes its children)
  let deleteIds = [...changeSet.deletes]
  if (changeSet.deletes.length > 0) {
    const allElements = await getElements(boardId)
    deleteIds = collectCascadeDeleteIds(allElements, changeSet.deletes)
  }

  // 2. Normalize + filter upserts (dedup, remove elements that are also deleted)
  const upserts = normalizeUpserts(changeSet.upserts)
    .filter(element => !deletedIdSet.has(element.id))
    .map(element => ({ ...element, updatedAt: Date.now() }))

  // 3. Increment sequence
  const sequence = await getSequence(boardId)  // INCR board:{id}:seq

  // 4. Build Redis pipeline
  const pipeline = redis.pipeline()

  // HSET each upserted element
  for (const element of upserts) {
    pipeline.hset(elementsKey, element.id, JSON.stringify(element))
  }

  // HDEL deleted elements
  if (deletes.length > 0) {
    pipeline.hdel(elementsKey, ...deletes)
  }

  // Append to change log (only in collab mode)
  if (trackChangeLog) {
    pipeline.rpush(boardChangeLogKey(boardId), JSON.stringify(persistedChange))
    pipeline.ltrim(boardChangeLogKey(boardId), -CHANGE_LOG_MAX_LENGTH, -1)  // cap at 2000
  }

  // Mark board as dirty
  pipeline.sadd(DIRTY_BOARDS_KEY, boardId)
  pipeline.zadd(DIRTY_BOARDS_BY_AGE_KEY, 'NX', serverTimestamp, boardId)
  pipeline.sadd(ACTIVE_BOARDS_KEY, boardId)

  // Track dirty since (first dirty timestamp, not overwritten)
  pipeline.setnx(boardDirtySinceKey(boardId), serverTimestamp.toString())

  // Increment dirty epoch (for optimistic concurrency)
  pipeline.incr(boardDirtyEpochKey(boardId))

  // Update last active
  pipeline.set(boardLastActiveKey(boardId), serverTimestamp.toString())

  // Track dirty element IDs (for incremental SQL flush)
  if (upserts.length > 0) {
    pipeline.sadd(dirtyElementIdsKey, ...upserts.map(e => e.id))
    pipeline.srem(deletedElementIdsKey, ...upserts.map(e => e.id))  // remove from deleted if re-added
  }
  if (deletes.length > 0) {
    pipeline.sadd(deletedElementIdsKey, ...deletes)
    pipeline.srem(dirtyElementIdsKey, ...deletes)
  }

  // Execute entire pipeline atomically
  await pipeline.exec()
}
```

### Redis Key Space

| Key | Type | Purpose |
|---|---|---|
| `board:{id}:elements` | HASH | All board elements (id → JSON) |
| `board:{id}:seq` | STRING | Monotonic sequence counter (INCR on each change) |
| `board:{id}:changes` | LIST | Change log (capped at 2000 entries) for reconnect catch-up |
| `board:{id}:dirty_element_ids` | SET | Elements modified but not yet flushed to SQL |
| `board:{id}:deleted_element_ids` | SET | Elements deleted but not yet flushed to SQL |
| `board:{id}:dirty_since` | STRING | Timestamp when board first became dirty |
| `board:{id}:dirty_epoch` | STRING | Incremented on each change, used for optimistic concurrency |
| `board:{id}:seen:{mutationId}` | STRING (300s TTL) | Deduplication — prevents same mutation applied twice |
| `board:{id}:last_active` | STRING | Timestamp of last activity |
| `boards:dirty` | SET | All boards with pending SQL writes |
| `boards:dirty_by_age` | SORTED SET | Dirty boards ordered by dirty-since timestamp |
| `boards:active` | SET | Boards with recent activity |
| `board:{id}:clients` | SET | Connected client members (`userId:connectionId`) |
| `board:{id}:client_lease:{member}` | STRING (90s TTL) | Client lease for staleness detection |
| `board:{id}:viewer_sessions` | SORTED SET | Active viewer sessions (score = timestamp) |
| `board:{id}:collab_mode_until` | STRING (90s TTL) | Collaboration mode cooldown |
| `board:{id}:load_lock` | STRING (30s TTL) | Distributed lock for board loading |
| `board:{id}:eviction_lock` | STRING (30s TTL) | Distributed lock for board eviction |

---

## 5. Mutation Types (`src/mutations/types.ts`)

```typescript
export enum MutationType {
  CREATE_ELEMENT = 'CREATE_ELEMENT',
  UPDATE_ELEMENT = 'UPDATE_ELEMENT',
  DELETE_ELEMENTS = 'DELETE_ELEMENTS',
  MOVE_ELEMENTS = 'MOVE_ELEMENTS',
  UPDATE_ELEMENTS = 'UPDATE_ELEMENTS',
  REORDER_ELEMENT = 'REORDER_ELEMENT',
}

export interface BoardElement {
  id: string
  kind: string
  x: number
  y: number
  zIndex: number
  updatedAt: number
  [key: string]: unknown    // extensible — any extra fields
}

export interface Mutation {
  mutationId: string         // client-generated unique ID
  boardId: string
  clientTimestamp: number
  operation: Operation      // one of the union types below
}

export type Operation =
  | { type: CREATE_ELEMENT; elementId: string; data: BoardElement }
  | { type: UPDATE_ELEMENT; elementId: string; fields: Partial<BoardElement> }
  | { type: DELETE_ELEMENTS; elementIds: string[] }
  | { type: MOVE_ELEMENTS; moves: Array<{ elementId: string; x: number; y: number }>; transient?: boolean }
  | { type: UPDATE_ELEMENTS; updates: Array<{ elementId: string; fields: Partial<BoardElement> }> }
  | { type: REORDER_ELEMENT; elementId: string; zIndex: number }
```

---

## 6. Cascade Delete Logic (`src/services/board-state/state-utils.ts:13-54`)

When deleting elements, children are recursively collected:

```typescript
function collectCascadeDeleteIds(allElements, requestedDeletes) {
  // Build two indexes:
  // containedByColumn: containerId → [childIds]  (structural children)
  // columnsByMeta: metaContainerId → [childIds]  (meta children)

  const pending = [...new Set(requestedDeletes)]
  const deletes = new Set(pending)

  while (pending.length > 0) {
    const currentId = pending.shift()!
    const containedChildren = containedByColumn.get(currentId) ?? []
    const metaChildren = columnsByMeta.get(currentId) ?? []

    for (const childId of [...containedChildren, ...metaChildren]) {
      if (deletes.has(childId)) continue  // already queued
      deletes.add(childId)
      pending.push(childId)  // BFS traversal
    }
  }

  return [...deletes]
}
```

---

## 7. Tick Persistence — Movement Compaction (`src/socketio/tick-persistence.ts`)

### Data Structures (line 17-20)

```typescript
const pendingTickMovesByBoard = new Map<string, Map<string, { x: number; y: number }>>()
//                                   boardId → elementId → latest position

const tickPersistDebounceTimers = new Map<string, NodeJS.Timeout>()
const tickPersistMaxWaitTimers = new Map<string, NodeJS.Timeout>()
const tickPersistUserByBoard = new Map<string, string>()
```

### `queueMoves()` (line 92-109)

Called by `realtime:tick` handler when a user is dragging:

```typescript
function queueMoves(boardId, userId, moves) {
  // Get or create pending moves map for this board
  let pendingMoves = pendingTickMovesByBoard.get(boardId)
  if (!pendingMoves) {
    pendingMoves = new Map()
    pendingTickMovesByBoard.set(boardId, pendingMoves)
  }

  // COMPACT: overwrite previous position for same element
  for (const move of moves) {
    pendingMoves.set(move.id, { x: move.x, y: move.y })  // ← THIS IS THE COMPACTION
  }

  tickPersistUserByBoard.set(boardId, userId)
  scheduleTickPersist(boardId)
}
```

**The compaction is the Map overwrite.** If element A moves through 100 positions in 500ms, only the last position survives in the Map.

### `scheduleTickPersist()` (line 73-90)

Two-timer pattern:

```typescript
function scheduleTickPersist(boardId) {
  // DEBOUNCE: resets on every new move
  if (debounceTimer) clearTimeout(debounceTimer)
  tickPersistDebounceTimers.set(boardId, setTimeout(() => {
    flushTickMoves(boardId)
  }, 400))  // TICK_PERSIST_DEBOUNCE_MS

  // MAX-WAIT: only set once per batch, guarantees flush within 1500ms
  if (!tickPersistMaxWaitTimers.has(boardId)) {
    tickPersistMaxWaitTimers.set(boardId, setTimeout(() => {
      flushTickMoves(boardId)
    }, 1500))  // TICK_PERSIST_MAX_WAIT_MS
  }
}
```

**Behavior**: If moves keep arriving every 100ms, the debounce keeps resetting (never fires). But the max-wait fires at 1500ms regardless. If moves stop for 400ms, the debounce fires.

### `flushTickMoves()` (line 36-71)

```typescript
async function flushTickMoves(boardId) {
  const pendingMoves = pendingTickMovesByBoard.get(boardId)
  if (!pendingMoves || pendingMoves.size === 0) return

  // Convert Map to array of { elementId, x, y }
  const moves = Array.from(pendingMoves.entries()).map(([elementId, position]) => ({
    elementId, x: position.x, y: position.y,
  }))

  pendingMoves.clear()
  clearTimers(boardId)

  // Ensure board is loaded in Redis
  await deps.boardStateService.loadBoard(boardId)

  // Create a single MOVE_ELEMENTS mutation
  const mutation: Mutation = {
    mutationId: `tick:${Date.now()}:${random}`,
    boardId,
    clientTimestamp: Date.now(),
    operation: { type: MutationType.MOVE_ELEMENTS, moves },
  }

  // Process through mutation processor (applies to Redis, deduplicates, etc.)
  const results = await deps.mutationProcessor.processBatch([mutation], userId)

  // Publish changes to Redis pub/sub for other instances
  for (const result of results) {
    if (result.status === 'applied' && result.change) {
      await options.onPersistedChange(boardId, userId, result.change, `tick:${boardId}`)
    }
  }
}
```

### Cleanup on Disconnect (`src/socketio/server.ts:176-185`)

```typescript
async function cleanupBoardRealtimeStateIfEmpty(boardId) {
  if (participantsStore.getRoomSize(boardId) > 0) return  // still people here

  // Flush any pending moves immediately
  await tickPersistence.flushTickMoves(boardId)
  await crdtStore.flushNow(boardId)

  // Clean up in-memory state
  tickPersistence.clearBoard(boardId)
  crdtStore.clearRoom(boardId)
}
```

---

## 8. CRDT Room — Yjs Position Sync (`src/socketio/crdt-room.ts`)

### Room State (line 11-19)

```typescript
interface CrdtRoomState {
  doc: Y.Doc                           // Yjs document
  moves: Y.Map<{ x: number; y: number }>  // Yjs map of positions
  pendingMoves: Map<string, { x: number; y: number }>  // compacted moves
  debounceTimer: NodeJS.Timeout | null
  maxWaitTimer: NodeJS.Timeout | null
  flushStartedAt: number | null
  lastEditorUserId: string
}
```

### `getOrCreateRoom()` (line 36-68)

Creates a Yjs document and sets up an observer:

```typescript
function getOrCreateRoom(boardId) {
  const doc = new Y.Doc()
  const moves = doc.getMap<{ x: number; y: number }>('moves')

  // Yjs observer — fires on any change to the moves map
  moves.observe((event) => {
    for (const [elementId, change] of event.changes.keys) {
      if (change.action === 'delete') continue
      const nextMove = moves.get(elementId)
      if (nextMove) {
        // COMPACT: only latest position per element
        room.pendingMoves.set(elementId, { x: nextMove.x, y: nextMove.y })
      }
    }
  })

  return room
}
```

### `applyRemoteUpdate()` (line 140-145)

```typescript
function applyRemoteUpdate(boardId, userId, update: Uint8Array) {
  const room = getOrCreateRoom(boardId)
  room.lastEditorUserId = userId
  Y.applyUpdate(room.doc, update, userId)  // apply CRDT binary update
  scheduleFlush(boardId)                   // debounce + max-wait (same pattern as tick)
}
```

### `flush()` (line 82-114)

Same pattern as tick persistence — converts pending moves to a `MOVE_ELEMENTS` mutation and processes it.

---

## 9. Realtime Tick Handler (`src/socketio/handlers/realtime-tick.handler.ts`)

```typescript
export function createRealtimeTickHandler(runtime) {
  return async (rawPayload) => {
    const payload = parseRealtimeTickPayload(rawPayload)
    const snapshot = runtime.takeContextSnapshot(payload.boardId)

    // Dedup by tickId (monotonically increasing per socket)
    if (payload.tickId <= runtime.getLastTickId()) return
    runtime.setLastTickId(payload.tickId)

    // Permission check for moves
    if (payload.moves.length > 0 && snapshot.context.permission !== 'edit') → error

    // Refresh activity
    await runtime.refreshSocketActivity(snapshot)

    // Queue moves for compaction (only if has edits)
    if (payload.moves.length > 0) {
      runtime.tickPersistence.queueMoves(payload.boardId, snapshot.context.userId, payload.moves)
    }

    // Broadcast full tick data to other clients (cursor, selection, presence, etc.)
    runtime.socket.to(payload.boardId).emit('realtime:tick', {
      boardId, tickId, sessionId, userId, userName, avatarUrl, color,
      cursor, selectedIds, draggedIds, focusedElementId, typingField,
      presenceState, presenceMessage, moves,
    })
  }
}
```

**Key distinction**: Moves go through `tickPersistence.queueMoves()` for compaction + persistence. The full tick data (cursor, presence, etc.) is broadcast immediately to other clients without persistence.

---

## 10. Redis Pub/Sub — Cross-Instance Fan-Out (`src/ws/pubsub.ts`)

### Setup (line 6-8)

```typescript
const subRedis = pubRedis.duplicate()  // separate connection for subscriber
const subscribedBoards = new Set<string>()
```

A **dedicated subscriber connection** is created by duplicating the publish connection. Redis requires separate connections for subscribe vs publish.

### Subscribe on First Client (line 32-39)

```typescript
function ensureSubscribedToBoard(boardId) {
  if (subscribedBoards.has(boardId)) return  // already subscribed
  subscribedBoards.add(boardId)
  subRedis.subscribe(`board:${boardId}:mutations`)
}
```

### Message Handler (line 10-30)

```typescript
subRedis.on('message', (channel, payload) => {
  const boardId = extractBoardIdFromChannel(channel)  // parse "board:{id}:mutations"
  const { message: serverMessage, senderConnectionId } = JSON.parse(payload)

  // Broadcast to all local WS connections on this board
  // Excludes the sender by connectionId
  roomManager.broadcastToRoom(boardId, serverMessage, senderConnectionId)
})
```

### Publish (line 46-49)

```typescript
async function publishMessage(boardId, message, senderConnectionId) {
  const payload = JSON.stringify({ message, senderConnectionId })
  await pubRedis.publish(`board:${boardId}:mutations`, payload)
}
```

### Socket.IO Publish (`src/socketio/server.ts:46-54`)

```typescript
async function publishElementsChanged(boardId, userId, change, senderId) {
  await deps.pubRedis.publish(
    `board:${boardId}:mutations`,
    JSON.stringify({
      message: { type: WS_ELEMENTS_CHANGED_TYPE, change, fromUserId: userId },
      senderConnectionId: `socketio:${senderId}`,  // prefixed with "socketio:"
    }),
  )
}
```

The `senderConnectionId` prefix distinguishes Socket.IO sources from raw WS sources. The WS layer's subscriber checks this prefix to avoid echoing back.

---

## 11. Catch-Up Sync on Reconnect (`src/ws/handler.utils.ts:48-67`)

```typescript
async function sendInitialState(ws, boardId, lastSequence, boardStateService, pubRedis) {
  if (lastSequence === 0) {
    // Fresh client — send full snapshot
    await sendSnapshot(ws, boardId, boardStateService, pubRedis)
    return
  }

  // Reconnecting client — try catch-up
  const catchUp = await boardStateService.getChangesAfter(boardId, lastSequence)

  if (catchUp.complete && catchUp.changes.length > 0) {
    // Log is complete — send delta
    ws.send(serialize({ type: 'CATCH_UP', changes: catchUp.changes }))
    return
  }

  // Log was trimmed (>2000 entries) — send full snapshot
  await sendSnapshot(ws, boardId, boardStateService, pubRedis)
}
```

### `getChangesAfter()` (`src/services/board-state/state-domain.ts:188-212`)

```typescript
async function getChangesAfter(boardId, afterSequence) {
  const currentSequence = await peekSequence(boardId)
  if (afterSequence >= currentSequence) {
    return { changes: [], complete: true }  // nothing new
  }

  // Read full change log from Redis LIST
  const rawChanges = await redis.lrange(boardChangeLogKey(boardId), 0, -1)
  const changes = rawChanges
    .map(raw => JSON.parse(raw))
    .filter(change => change.sequence > afterSequence)
    .sort((left, right) => left.sequence - right.sequence)

  if (changes.length === 0) {
    return { changes: [], complete: false }  // log was trimmed, can't catch up
  }

  // Check if the first change's sequence matches what we expect
  return {
    changes,
    complete: changes[0]?.sequence === afterSequence + 1,  // log is continuous
  }
}
```

---

## 12. Disconnect Flow (`src/socketio/handlers/disconnect.handler.ts`)

```typescript
export function createDisconnectHandler(runtime, cleanupConnectionState) {
  return async () => {
    const context = runtime.getBoardContext()
    if (!context) {
      cleanupConnectionState()
      return
    }

    runtime.setBoardContext(null)
    await runtime.detachFromBoard(context, true)  // broadcastLeave = true
    cleanupConnectionState()
  }
}
```

### `detachFromBoard()` (`src/socketio/server.ts:194-205`)

```typescript
async function detachFromBoard(context, broadcastLeave) {
  // 1. Remove from Redis client tracking
  await deps.boardStateService.removeClient(boardId, userId, socket.id)
  await deps.boardStateService.removeViewerSession(boardId, sessionId)

  // 2. Remove from in-memory participant store
  const participant = participantsStore.removeParticipant(boardId, socket.id)
  if (broadcastLeave && participant) {
    emitUserLeft(boardId, participant)  // io.to(boardId).emit('USER_LEFT', ...)
  }

  // 3. Leave Socket.IO room
  socket.leave(context.boardId)

  // 4. Flush pending tick/CRDT moves if no one left
  await cleanupBoardRealtimeStateIfEmpty(boardId)

  // 5. Persist board if last global client
  await persistBoardOnGlobalDrain(boardId)
}
```

### `persistBoardOnGlobalDrain()` (line 187-192)

```typescript
async function persistBoardOnGlobalDrain(boardId) {
  const globalClientCount = await deps.boardStateService.getClientCount(boardId)
  if (globalClientCount <= 1) {
    await deps.boardStateService.persistBoard(boardId)
  }
}
```

The `<= 1` check is because the current socket hasn't been removed from Redis yet at this point (removeClient was called, but the count was read after removal). Actually looking more carefully — `removeClient` is called first (line 195), then `getClientCount` (line 188). So `<= 1` means "0 or 1 clients remaining" — but since we just removed ourselves, 0 means we were the last.

---

## 13. SQL Persistence — The Flush Path

### Background Worker (`src/services/board-persistence.service.ts`)

```typescript
const DEFAULT_PERSIST_INTERVAL_MS = 30_000   // run every 30s
const DEFAULT_PERSIST_WINDOW_MS = 30_000     // only flush boards dirty >= 30s
const DEFAULT_RETRY_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 250

function startWorker(intervalMs = DEFAULT_PERSIST_INTERVAL_MS) {
  return setInterval(async () => {
    await flushDirtyBoards()
  }, intervalMs)
}
```

### `persistDirtyBoards()` (`src/services/board-state/persistence-domain.ts:458-496`)

```typescript
async function persistDirtyBoards(options) {
  const { limit, minDirtyAgeMs, retryAttempts, retryDelayMs } = options

  // Get boards from sorted set, only those dirty >= minDirtyAgeMs
  const maxScore = (now - minDirtyAgeMs).toString()
  const boardIds = await redis.zrangebyscore(DIRTY_BOARDS_BY_AGE_KEY, '-inf', maxScore, 'LIMIT', 0, limit)

  const persisted = []
  for (const boardId of boardIds) {
    // Double-check dirty age
    const dirtySince = await getDirtySince(boardId)
    if (dirtySince > 0 && (Date.now() - dirtySince) < minDirtyAgeMs) continue

    // Retry loop
    let attempt = 0
    while (attempt < retryAttempts) {
      attempt++
      try {
        await persistBoard(boardId)
        persisted.push(boardId)
        break
      } catch (error) {
        if (attempt >= retryAttempts) break
        await sleep(retryDelayMs)  // 250ms between retries
      }
    }
  }
  return persisted
}
```

### `persistBoard()` — The Actual SQL Write (line 304-422)

```typescript
async function persistBoard(boardId) {
  await waitForBoardLoad(boardId)  // ensure board is in Redis
  await withPersistLock(boardId, async () => {  // per-board serialization

    // 1. Validate boardId is UUID
    if (!isUuidLike(boardId)) { await clearInvalidBoardState(boardId); return }

    // 2. Verify board exists in PostgreSQL
    if (!(await boardExistsSafely(boardId))) { await clearMissingBoardState(boardId); return }

    // 3. Check if board is actually loaded in Redis
    const isLoaded = await redis.exists(boardSeqKey(boardId))
    if (isLoaded !== 1) { /* clean up stale dirty markers */ return }

    // 4. Snapshot current state
    const flushStartedAt = Date.now()
    const dirtySince = await getDirtySince(boardId)
    const snapshotSequence = await peekSequence(boardId)
    const snapshotDirtyEpoch = await getDirtyEpoch(boardId)
    const serverTimestamp = new Date()

    // 5. Write to PostgreSQL
    const persistedCounts = enableIncrementalPersistence
      ? await persistBoardIncremental(boardId, serverTimestamp)
      : { upserts: await persistBoardFullSnapshot(boardId, serverTimestamp), deletes: 0 }

    // 6. Atomic cleanup via Lua script
    const cleared = await redis.eval(`
      -- Verify epoch hasn't changed (optimistic concurrency)
      local currentEpoch = tonumber(redis.call('get', KEYS[1]) or '0')
      local expectedEpoch = tonumber(ARGV[1])
      if currentEpoch ~= expectedEpoch then return 0 end

      -- Clean up dirty state
      redis.call('srem', KEYS[2], ARGV[2])        -- boards:dirty
      redis.call('zrem', KEYS[3], ARGV[2])        -- boards:dirty_by_age
      redis.call('del', KEYS[4])                   -- board:{id}:dirty_since
      redis.call('set', KEYS[5], ARGV[3])          -- board:{id}:last_flushed_seq
      redis.call('set', KEYS[6], ARGV[4])          -- board:{id}:last_flushed_at
      redis.call('set', KEYS[7], ARGV[5])          -- board:{id}:last_flush_duration_ms

      if ARGV[6] == '1' then
        redis.call('del', KEYS[8])                 -- board:{id}:dirty_element_ids
        redis.call('del', KEYS[9])                 -- board:{id}:deleted_element_ids
      end

      return 1
    `, 9, /* KEYS and ARGVs */)
  })
}
```

### Incremental vs Full Snapshot Persistence

**Incremental** (`persistBoardIncremental`, line 235-302):

```typescript
async function persistBoardIncremental(boardId, serverTimestamp) {
  // 1. Read only dirty + deleted element IDs from Redis SETs
  const [dirtyIds, deletedIds] = await Promise.all([
    redis.smembers(boardDirtyElementIdsKey(boardId)),
    redis.smembers(boardDeletedElementIdsKey(boardId)),
  ])

  if (dirtyIds.length === 0 && deletedIds.length === 0) return { upserts: 0, deletes: 0 }

  // 2. Read current state of dirty elements from Redis HASH
  const rawDirtyElements = await redis.hmget(boardElementsKey(boardId), ...dirtyIds)

  // 3. Parse and build SQL rows
  for (let i = 0; i < dirtyIds.length; i++) {
    const json = rawDirtyElements[i]
    if (!json) { deletes.add(dirtyIds[i]); continue }  // element was deleted from Redis
    upserts.push(toElementRow(boardId, JSON.parse(json), serverTimestamp))
  }

  // 4. SQL transaction
  await db.transaction(async (tx) => {
    if (deletes.size > 0) {
      await tx.delete(elements).where(and(
        eq(elements.boardId, boardId),
        inArray(elements.id, [...deletes])
      ))
    }
    if (upserts.length > 0) {
      await tx.insert(elements).values(upserts)
        .onConflictDoUpdate({
          target: elements.id,
          set: { boardId, type: sql`excluded.type`, data: sql`excluded.data`, updatedAt: serverTimestamp },
        })
    }
    await tx.update(boards).set({ updatedAt: serverTimestamp }).where(eq(boards.id, boardId))
  })
}
```

**Full snapshot** (`persistBoardFullSnapshot`, line 220-233):

```typescript
async function persistBoardFullSnapshot(boardId, serverTimestamp) {
  const currentElements = await getElements(boardId)  // ALL elements from Redis
  const nextRows = Object.values(currentElements).map(e => toElementRow(boardId, e, serverTimestamp))

  await db.transaction(async (tx) => {
    await tx.delete(elements).where(eq(elements.boardId, boardId))  // DELETE ALL
    if (nextRows.length > 0) {
      await tx.insert(elements).values(nextRows)  // INSERT ALL
    }
    await tx.update(boards).set({ updatedAt: serverTimestamp }).where(eq(boards.id, boardId))
  })
}
```

### Optimistic Concurrency — Why the Lua Script Matters

The `dirty_epoch` counter prevents lost concurrent flushes:

1. Server A reads `dirty_epoch = 5`, starts flushing to SQL
2. Server B processes a mutation, increments `dirty_epoch` to 6
3. Server A finishes SQL write, runs Lua script
4. Lua checks: `currentEpoch (6) != expectedEpoch (5)` → returns 0
5. Server A's flush is "skipped" — the dirty state remains for the next flush cycle

This prevents Server A from clearing dirty markers for changes Server B made during the flush.

---

## 14. Redis Cleanup Service (`src/services/redis-cleanup.service.ts`)

### Background Worker (line 204-228)

Runs every **2 minutes** (`DEFAULT_CLEANUP_INTERVAL_MS = 120_000`):

```typescript
function startWorker(intervalMs) {
  return setInterval(async () => {
    if (isWorkerRunning) return  // prevent overlapping runs
    isWorkerRunning = true
    try {
      const [flushed, transientDeleted] = await Promise.all([
        cleanupInactiveBoards(),
        cleanupTransientDataByIdleTime(),
      ])
    } finally {
      isWorkerRunning = false
    }
  }, intervalMs)
}
```

### Finding Inactive Boards (line 108-180)

Three strategies, tried in order:

1. **Active index sampling** (line 112-127): `SRANDMEMBER boards:active` samples boards, checks `last_active` timestamp
2. **Last-active key scan** (line 130): `SCAN board:*:last_active` pattern
3. **Sequence key scan** (line 153): `SCAN board:*:seq` pattern, then `OBJECT IDLETIME` for each

### Eviction (line 182-202)

```typescript
async function cleanupInactiveBoards(idleTtlMs = 3 minutes, limit = 50) {
  const inactiveBoardIds = await findInactiveBoardCandidates(idleTtlMs, limit)

  for (const boardId of inactiveBoardIds) {
    // Skip if anyone is still connected
    const [clientCount, viewerCount] = await Promise.all([
      boardStateService.getClientCount(boardId),
      boardStateService.getActiveViewerCount(boardId),
    ])
    if (clientCount > 0 || viewerCount > 0) continue

    // Persist to SQL then delete all Redis keys
    await boardStateService.persistBoard(boardId)
    await boardStateService.flushBoard(boardId, { requireIdle: true })
  }
}
```

### `flushBoard()` — Evicting from Redis (line 498-533)

```typescript
async function flushBoard(boardId, options) {
  // Acquire eviction lock (SET NX PX 30000)
  const token = await acquireEvictionLock(boardId)
  if (!token) return  // another instance is evicting

  try {
    if (requireIdle && !(await isBoardIdleForFlush(boardId))) return

    // SCAN for all board:*:keys and DEL them
    const pattern = `board:${boardId}:*`
    let cursor = '0'
    do {
      const [nextCursor, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = nextCursor
      keys.push(...found)
    } while (cursor !== '0')

    if (keys.length > 0) {
      await redis.del(...keys)
    }

    // Remove from global indexes
    await redis.pipeline()
      .srem('boards:dirty', boardId)
      .zrem('boards:dirty_by_age', boardId)
      .srem('boards:active', boardId)
      .exec()
  } finally {
    await releaseEvictionLock(boardId, token)  // Lua script: check token then DEL
  }
}
```

---

## 15. Presence Domain (`src/services/board-state/presence-domain.ts`)

### `trackClient()` (line 25-38)

```typescript
async function trackClient(boardId, userId, connectionId) {
  const member = `${userId}:${connectionId}`  // clientMember()
  await redis.pipeline()
    .sadd(boardClientsKey(boardId), member)           // add to client set
    .set(boardClientLeaseKey(boardId, member), '1',
         'EX', CLIENT_LEASE_TTL_SECONDS)              // 90s lease
    .sadd(ACTIVE_BOARDS_KEY, boardId)                 // mark board active
    .exec()

  const clientCount = await redis.scard(boardClientsKey(boardId))
  await extendCollabModeIfNeeded(boardId, clientCount)
}
```

### `getSyncWriteMode()` (line 127-149)

Determines solo vs collab mode:

```typescript
async function getSyncWriteMode(boardId) {
  // Check if collab mode cooldown is active
  const collabUntilRaw = await redis.get(boardCollabModeUntilKey(boardId))
  if (collabUntilRaw) {
    const collabUntil = parseInt(collabUntilRaw, 10)
    if (collabUntil > Date.now()) return 'collab'
  }

  // Check actual client/viewer counts
  const [clientCount, viewerCount] = await Promise.all([
    getClientCount(boardId),
    getActiveViewerCount(boardId),
  ])

  if (clientCount >= 2 || viewerCount >= 2) {
    await extendCollabMode(boardId)  // set 90s cooldown
    return 'collab'
  }

  return 'solo'
}
```

### `touchViewerSession()` (line 86-101)

```typescript
async function touchViewerSession(boardId, sessionId) {
  const now = Date.now()
  const minActiveTimestamp = now - VIEWER_SESSION_TTL_MS  // 90s window

  await redis.pipeline()
    .zadd(boardViewerSessionsKey(boardId), now, sessionId)          // add/update
    .zremrangebyscore(boardViewerSessionsKey(boardId), 0, minActiveTimestamp)  // prune stale
    .set(boardLastActiveKey(boardId), now.toString())               // update last active
    .sadd(ACTIVE_BOARDS_KEY, boardId)                              // mark active
    .exec()
}
```

---

## 16. Mutation Compaction — SQL Audit Log GC (`src/mutations/compaction.ts`)

Runs every **10 minutes**:

```typescript
async function compactStaleMutations() {
  // SCAN all board:*:last_active keys
  const keys = await scanLastActiveKeys(redis)

  for (const key of keys) {
    const boardId = extractBoardIdFromKey(key)
    const lastActiveTs = parseInt(await redis.get(key), 10)

    // Only clean up boards idle > 1 hour
    if (Date.now() - lastActiveTs <= ONE_HOUR_MS) continue

    // DELETE old mutation rows
    await db.execute(
      sql`DELETE FROM mutations WHERE board_id = ${boardId}::uuid
          AND server_ts < now() - interval '1 hour'`
    )
  }
}
```

---

## 17. WS Handler — Mutation Batching (`src/ws/handler.ts`)

The raw WebSocket layer has its own batching mechanism:

```typescript
const MUTATION_BATCH_WINDOW_MS = 12     // 12ms debounce
const MUTATION_BATCH_MAX_SIZE = 25      // max mutations per batch

function enqueueMutation(boardId, userId, connectionId, ws, mutation) {
  const batchState = getOrCreateBatch(connectionId)
  batchState.mutations.push(mutation)

  // Flush immediately if batch is full
  if (batchState.mutations.length >= MUTATION_BATCH_MAX_SIZE) {
    void flushMutationBatch(boardId, userId, connectionId, ws)
    return
  }

  // Otherwise, set 12ms debounce timer
  if (batchState.flushTimer) return  // already scheduled
  batchState.flushTimer = setTimeout(() => {
    void flushMutationBatch(boardId, userId, connectionId, ws)
  }, MUTATION_BATCH_WINDOW_MS)
}
```

### Transient Moves — Broadcast Only (line 280-295)

```typescript
if (message.mutation.operation.type === 'MOVE_ELEMENTS' && message.mutation.operation.transient) {
  // Just broadcast, don't persist
  await mutationPubSub.publishMessage(boardId, { type: 'MUTATION', mutation }, connectionId)
  ws.send(serialize({
    type: 'MUTATION_RESULT',
    result: { mutationId, status: 'broadcast_only', serverTimestamp: Date.now() },
  }))
  return  // skip enqueueMutation
}
```

### Disconnect with Grace Period (line 334-365)

```typescript
ws.on('close', async () => {
  // Flush any pending batch first
  await flushMutationBatch(boardId, userId, connectionId, ws, { sendAcks: false })

  const leaveResult = roomManager.leaveRoom(boardId, connectionId)
  await boardStateService.removeClient(boardId, userId, connectionId)

  const globalClientCount = await boardStateService.getClientCount(boardId)
  if (globalClientCount <= 1) {
    await boardStateService.persistBoard(boardId)  // persist if last client
  }
  if (globalClientCount === 0) {
    scheduleRoomFlush(boardId)  // 30s grace period before eviction
  }
})
```

The grace period (line 63-76) waits 30 seconds before evicting:

```typescript
function scheduleRoomFlush(boardId) {
  cancelGracePeriod(boardId)
  const timer = setTimeout(async () => {
    const roomSize = roomManager.getRoomSize(boardId)
    if (roomSize > 0) return
    if (!(await isBoardGloballyIdle(boardId, boardStateService))) return
    await boardStateService.persistBoard(boardId)
    await boardStateService.flushBoard(boardId)
    mutationPubSub.unsubscribeFromBoard(boardId)
  }, ROOM_FLUSH_GRACE_PERIOD_MS)  // 30_000
}
```

---

## 18. Solo vs Collab Mode

| Aspect | Solo (1 user) | Collab (2+ users) |
|---|---|---|
| SQL persistence | **Immediate** after each mutation batch | **Deferred** (background 30s, min dirty 30s) |
| Change log tracking | Not tracked | Tracked (for catch-up sync) |
| Cooldown | None | 90s after last collaborator leaves |
| Determined by | `getSyncWriteMode()` | `getSyncWriteMode()` |

---

## 19. Complete Data Flow — End to End

```
Client drags element
  │
  ├─ Socket.IO `realtime:tick` event
  │   ├─ Dedup by tickId (monotonic)
  │   ├─ queueMoves() → Map overwrites (COMPACTION)
  │   ├─ Debounce timer reset (400ms)
  │   └─ Max-wait timer (1500ms)
  │
  ├─ After debounce/max-wait fires
  │   ├─ flushTickMoves() → builds MOVE_ELEMENTS mutation
  │   └─ mutationProcessor.processBatch()
  │       ├─ Dedup via SET NX (board:{id}:seen:{mutationId})
  │       ├─ toChangeSet() → { upserts, deletes }
  │       ├─ applyChangeSet()
  │       │   ├─ INCR board:{id}:seq
  │       │   ├─ HSET board:{id}:elements (update position)
  │       │   ├─ RPUSH board:{id}:changes (if collab)
  │       │   ├─ SADD boards:dirty
  │       │   ├─ SADD board:{id}:dirty_element_ids
  │       │   ├─ INCR board:{id}:dirty_epoch
  │       │   └─ Pipeline.exec()
  │       └─ If solo: persistBoard() immediately
  │
  ├─ publishElementsChanged()
  │   └─ PUBLISH board:{id}:mutations
  │       └─ Other instances SUBSCRIBE → broadcast to local clients
  │
  └─ Background flusher (every 30s)
      ├─ ZRANGEBYSCORE boards:dirty_by_age (boards dirty >= 30s)
      └─ For each board:
          ├─ SMEMBERS board:{id}:dirty_element_ids
          ├─ HMGET board:{id}:elements (current state)
          ├─ SQL UPSERT / DELETE
          └─ Lua: verify dirty_epoch → clear dirty state
```

---

## 20. Python Implementation from Scratch

### Layer 1: Core State + Mutation Processing

```python
# state.py
import json
import time
import redis.asyncio as aioredis
from dataclasses import dataclass, field
from enum import Enum

class MutationType(Enum):
    CREATE_ELEMENT = 'CREATE_ELEMENT'
    UPDATE_ELEMENT = 'UPDATE_ELEMENT'
    DELETE_ELEMENTS = 'DELETE_ELEMENTS'
    MOVE_ELEMENTS = 'MOVE_ELEMENTS'

@dataclass
class Mutation:
    mutation_id: str
    board_id: str
    client_timestamp: float
    operation: dict

class BoardStateService:
    def __init__(self, redis: aioredis.Redis):
        self.r = redis

    async def try_mark_seen(self, board_id: str, mutation_id: str) -> bool:
        """Dedup via SET NX with 300s TTL. Returns True if we claimed it."""
        result = await self.r.set(
            f'board:{board_id}:seen:{mutation_id}', '1',
            ex=300, nx=True
        )
        return result is not None

    async def apply_change_set(self, board_id: str, change_set: dict) -> dict | None:
        """Atomically update Redis state. Returns the persisted change or None."""
        upserts = change_set.get('upserts', [])
        deletes = change_set.get('deletes', [])

        if not upserts and not deletes:
            return None

        # Increment sequence
        sequence = await self.r.incr(f'board:{board_id}:seq')
        server_ts = time.time() * 1000

        pipe = self.r.pipeline()

        # Update elements
        for elem in upserts:
            elem['updatedAt'] = server_ts
            pipe.hset(f'board:{board_id}:elements', elem['id'], json.dumps(elem))
        if deletes:
            pipe.hdel(f'board:{board_id}:elements', *deletes)

        # Append to change log (collab mode)
        change = {
            'sequence': sequence,
            'serverTimestamp': server_ts,
            'upserts': upserts,
            'deletes': deletes,
        }
        pipe.rpush(f'board:{board_id}:changes', json.dumps(change))
        pipe.ltrim(f'board:{board_id}:changes', -2000, -1)

        # Mark dirty
        pipe.sadd('boards:dirty', board_id)
        pipe.zadd('boards:dirty_by_age', {board_id: server_ts})
        pipe.sadd('boards:active', board_id)
        pipe.setnx(f'board:{board_id}:dirty_since', str(server_ts))
        pipe.incr(f'board:{board_id}:dirty_epoch')
        pipe.set(f'board:{board_id}:last_active', str(server_ts))

        # Track dirty element IDs
        if upserts:
            pipe.sadd(f'board:{board_id}:dirty_element_ids', *[e['id'] for e in upserts])
            pipe.srem(f'board:{board_id}:deleted_element_ids', *[e['id'] for e in upserts])
        if deletes:
            pipe.sadd(f'board:{board_id}:deleted_element_ids', *deletes)
            pipe.srem(f'board:{board_id}:dirty_element_ids', *deletes)

        await pipe.execute()
        return change


class MutationProcessor:
    def __init__(self, state: BoardStateService):
        self.state = state

    async def process_batch(self, mutations: list[Mutation], user_id: str) -> list[dict]:
        results = []
        for mutation in mutations:
            result = await self._process_mutation(mutation, user_id)
            results.append(result)
        return results

    async def _process_mutation(self, mutation: Mutation, user_id: str) -> dict:
        # Dedup
        if not await self.state.try_mark_seen(mutation.board_id, mutation.mutation_id):
            return {'mutationId': mutation.mutation_id, 'status': 'already_applied'}

        # Build change set
        op = mutation.operation
        change_set = {'upserts': [], 'deletes': []}

        if op['type'] == MutationType.MOVE_ELEMENTS.value:
            for move in op['moves']:
                # Read existing element, update position
                raw = await self.state.r.hget(
                    f'board:{mutation.board_id}:elements', move['elementId']
                )
                if raw:
                    elem = json.loads(raw)
                    elem['x'] = move['x']
                    elem['y'] = move['y']
                    change_set['upserts'].append(elem)
        elif op['type'] == MutationType.CREATE_ELEMENT.value:
            change_set['upserts'].append(op['data'])
        elif op['type'] == MutationType.DELETE_ELEMENTS.value:
            change_set['deletes'] = op['elementIds']

        # Apply to Redis
        persisted = await self.state.apply_change_set(mutation.board_id, change_set)

        return {
            'mutationId': mutation.mutation_id,
            'status': 'applied',
            'change': persisted,
        }
```

### Layer 2: Tick Compactor (Movement Compaction)

```python
# tick_compactor.py
import asyncio
import json
import time
import random

class TickCompactor:
    """Compacts rapid movement updates: only latest position per element survives."""

    def __init__(self, processor: MutationProcessor, pub_callback):
        self.processor = processor
        self.pub_callback = pub_callback
        self.pending: dict[str, dict[str, dict]] = {}  # board_id → {elem_id → {x,y}}
        self.debounce_timers: dict[str, asyncio.Task] = {}
        self.maxwait_timers: dict[str, asyncio.Task] = {}
        self.user_by_board: dict[str, str] = {}

    def queue_moves(self, board_id: str, user_id: str, moves: list[dict]):
        """Queue moves. Map overwrite = compaction."""
        if board_id not in self.pending:
            self.pending[board_id] = {}

        # COMPACT: only latest position per element
        for move in moves:
            self.pending[board_id][move['id']] = {'x': move['x'], 'y': move['y']}

        self.user_by_board[board_id] = user_id
        self._schedule_flush(board_id)

    def _schedule_flush(self, board_id: str):
        # Reset debounce (400ms)
        if board_id in self.debounce_timers:
            self.debounce_timers[board_id].cancel()
        self.debounce_timers[board_id] = asyncio.create_task(
            self._debounced_flush(board_id)
        )

        # Set max-wait (1500ms) only once per batch
        if board_id not in self.maxwait_timers:
            self.maxwait_timers[board_id] = asyncio.create_task(
                self._maxwait_flush(board_id)
            )

    async def _debounced_flush(self, board_id):
        await asyncio.sleep(0.4)
        await self.flush(board_id)

    async def _maxwait_flush(self, board_id):
        await asyncio.sleep(1.5)
        await self.flush(board_id)

    async def flush(self, board_id):
        moves = self.pending.pop(board_id, {})
        self.debounce_timers.pop(board_id, None)
        self.maxwait_timers.pop(board_id, None)

        if not moves:
            return

        user_id = self.user_by_board.pop(board_id, 'system:tick')

        # Build single MOVE_ELEMENTS mutation from compacted positions
        mutation = Mutation(
            mutation_id=f'tick:{int(time.time()*1000)}:{random.randint(0,99999)}',
            board_id=board_id,
            client_timestamp=time.time() * 1000,
            operation={
                'type': 'MOVE_ELEMENTS',
                'moves': [{'elementId': eid, 'x': pos['x'], 'y': pos['y']}
                          for eid, pos in moves.items()],
            },
        )

        results = await self.processor.process_batch([mutation], user_id)

        for result in results:
            if result['status'] == 'applied' and result.get('change'):
                await self.pub_callback(board_id, user_id, result['change'])
```

### Layer 3: SQL Persistence with Dirty Tracking + Lua Cleanup

```python
# persistence.py
import asyncio
import json
import time
import redis.asyncio as aioredis
import asyncpg

LUA_CLEANUP = """
local currentEpoch = tonumber(redis.call('get', KEYS[1]) or '0')
local expectedEpoch = tonumber(ARGV[1])
if currentEpoch ~= expectedEpoch then
    return 0
end
redis.call('srem', KEYS[2], ARGV[2])
redis.call('zrem', KEYS[3], ARGV[2])
redis.call('del', KEYS[4])
redis.call('set', KEYS[5], ARGV[3])
redis.call('set', KEYS[6], ARGV[4])
redis.call('set', KEYS[7], ARGV[5])
redis.call('del', KEYS[8])
redis.call('del', KEYS[9])
return 1
"""

class BoardPersistenceService:
    def __init__(self, redis: aioredis.Redis, db: asyncpg.Pool):
        self.r = redis
        self.db = db
        self.persist_locks: dict[str, asyncio.Lock] = {}

    def _get_lock(self, board_id: str) -> asyncio.Lock:
        if board_id not in self.persist_locks:
            self.persist_locks[board_id] = asyncio.Lock()
        return self.persist_locks[board_id]

    async def persist_board(self, board_id: str):
        """Flush dirty elements for one board from Redis → PostgreSQL."""
        async with self._get_lock(board_id):
            dirty = await self.r.smembers(f'board:{board_id}:dirty_element_ids')
            deleted = await self.r.smembers(f'board:{board_id}:deleted_element_ids')

            if not dirty and not deleted:
                return

            # Snapshot epoch before SQL write
            dirty_epoch = await self.r.get(f'board:{board_id}:dirty_epoch') or '0'
            sequence = await self.r.get(f'board:{board_id}:seq') or '0'
            flush_started = time.time() * 1000

            # Read current state of dirty elements from Redis
            upserts = []
            if dirty:
                raw_elements = await self.r.hmget(
                    f'board:{board_id}:elements', dirty
                )
                for elem_id_bytes, data in zip(dirty, raw_elements):
                    if data is None:
                        continue
                    elem = json.loads(data)
                    upserts.append({
                        'id': elem_id_bytes.decode(),
                        'board_id': board_id,
                        'type': elem.get('kind', 'unknown'),
                        'data': elem,
                    })

            # SQL transaction
            async with self.db.acquire() as conn:
                async with conn.transaction():
                    if deleted:
                        deleted_ids = [d.decode() for d in deleted]
                        await conn.execute(
                            'DELETE FROM elements WHERE id = ANY($1) AND board_id = $2',
                            deleted_ids, board_id,
                        )
                    for elem in upserts:
                        await conn.execute("""
                            INSERT INTO elements (id, board_id, type, data)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (id) DO UPDATE SET
                                type = $3, data = $4
                        """, elem['id'], elem['board_id'], elem['type'],
                             json.dumps(elem['data']))
                    await conn.execute(
                        'UPDATE boards SET updated_at = NOW() WHERE id = $1',
                        board_id,
                    )

            # Atomic cleanup via Lua
            flush_completed = time.time() * 1000
            await self.r.eval(
                LUA_CLEANUP, 9,
                f'board:{board_id}:dirty_epoch',
                'boards:dirty',
                'boards:dirty_by_age',
                f'board:{board_id}:dirty_since',
                f'board:{board_id}:last_flushed_seq',
                f'board:{board_id}:last_flushed_at',
                f'board:{board_id}:last_flush_duration_ms',
                f'board:{board_id}:dirty_element_ids',
                f'board:{board_id}:deleted_element_ids',
                dirty_epoch,
                board_id,
                sequence,
                str(int(flush_completed)),
                str(int(flush_completed - flush_started)),
            )

    async def start_worker(self, interval: int = 30, min_dirty_age: int = 30):
        """Background loop: flush boards dirty >= min_dirty_age seconds."""
        while True:
            await asyncio.sleep(interval)
            cutoff = time.time() * 1000 - (min_dirty_age * 1000)
            board_ids = await self.r.zrangebyscore(
                'boards:dirty_by_age', 0, cutoff
            )
            for board_id_bytes in board_ids:
                board_id = board_id_bytes.decode()
                for attempt in range(3):  # 3 retries
                    try:
                        await self.persist_board(board_id)
                        break
                    except Exception as e:
                        if attempt == 2:
                            print(f'Failed to persist {board_id}: {e}')
                        await asyncio.sleep(0.25)
```

### Layer 4: Redis Cleanup (Eviction)

```python
# cleanup.py
import asyncio
import redis.asyncio as aioredis

class RedisCleanupService:
    def __init__(self, redis: aioredis.Redis, persistence: BoardPersistenceService):
        self.r = redis
        self.persistence = persistence
        self.running = False

    async def cleanup_inactive_boards(self, idle_ttl_ms: int = 180_000, limit: int = 50):
        """Find and evict boards idle > idle_ttl_ms with no clients."""
        # Strategy 1: sample from boards:active
        candidates = set()
        sampled = await self.r.srandmember('boards:active', limit * 3)
        for board_id_bytes in sampled:
            board_id = board_id_bytes.decode()
            raw = await self.r.get(f'board:{board_id}:last_active')
            if raw and (time.time() * 1000 - float(raw)) >= idle_ttl_ms:
                candidates.add(board_id)
            if len(candidates) >= limit:
                break

        for board_id in candidates:
            client_count = await self.r.scard(f'board:{board_id}:clients')
            if client_count > 0:
                continue

            # Persist + evict
            await self.persistence.persist_board(board_id)
            await self._flush_board(board_id)

    async def _flush_board(self, board_id: str):
        """Delete all Redis keys for a board."""
        pattern = f'board:{board_id}:*'
        keys = []
        cursor = '0'
        while True:
            cursor, found = await self.r.scan(cursor, match=pattern, count=100)
            keys.extend(found)
            if cursor == '0':
                break

        if keys:
            await self.r.delete(*keys)

        pipe = self.r.pipeline()
        pipe.srem('boards:dirty', board_id)
        pipe.zrem('boards:dirty_by_age', board_id)
        pipe.srem('boards:active', board_id)
        await pipe.execute()

    async def start_worker(self, interval: int = 120):
        """Run every 2 minutes."""
        while True:
            await asyncio.sleep(interval)
            if self.running:
                continue
            self.running = True
            try:
                await self.cleanup_inactive_boards()
            finally:
                self.running = False
```

### Layer 5: Pub/Sub Cross-Instance Fan-Out

```python
# pubsub.py
import json
import redis.asyncio as aioredis
import socketio

class CrossInstancePubSub:
    def __init__(self, pub_redis: aioredis.Redis):
        self.pub_redis = pub_redis
        self.sub_redis = pub_redis.duplicate()  # separate connection
        self.subscribed_boards: set[str] = set()
        self.sio: socketio.AsyncServer | None = None

    def set_sio(self, sio: socketio.AsyncServer):
        self.sio = sio

    def ensure_subscribed(self, board_id: str):
        if board_id in self.subscribed_boards:
            return
        self.subscribed_boards.add(board_id)
        asyncio.create_task(self._subscribe(board_id))

    async def _subscribe(self, board_id: str):
        pubsub = self.sub_redis.pubsub()
        await pubsub.subscribe(f'board:{board_id}:mutations')
        async for message in pubsub.listen():
            if message['type'] != 'message':
                continue
            data = json.loads(message['data'])
            sender = data.get('senderConnectionId', '')
            # Don't echo back to local sender
            if sender.startswith('local:'):
                continue
            await self.sio.emit('mutation', data, room=board_id)

    async def publish(self, board_id: str, change: dict, sender_id: str):
        await self.pub_redis.publish(
            f'board:{board_id}:mutations',
            json.dumps({
                'message': {'type': 'ELEMENTS_CHANGED', 'change': change},
                'senderConnectionId': f'local:{sender_id}',
            }),
        )
```

### Layer 6: Socket.IO Server

```python
# main.py
import asyncio
import socketio
import json
import time
import random
import asyncpg
import redis.asyncio as aioredis

sio = socketio.AsyncServer(async_mode='asgi')
r = aioredis.Redis()

# Initialize services
state = BoardStateService(r)
processor = MutationProcessor(state)
tick = TickCompactor(state, processor)
pubsub = CrossInstancePubSub(r)

@sio.event
async def board_join(sid, data):
    board_id = data['boardId']

    # Lazy load from SQL
    exists = await r.exists(f'board:{board_id}:seq')
    if not exists:
        await load_board_from_sql(board_id)

    sio.enter_room(sid, board_id)
    pubsub.ensure_subscribed(board_id)

    # Track client
    await r.pipeline()
        .sadd(f'board:{board_id}:clients', f'{data["userId"]}:{sid}')
        .set(f'board:{board_id}:client_lease:{data["userId"]}:{sid}', '1', ex=90)
        .execute()

    # Send snapshot
    elements = await r.hgetall(f'board:{board_id}:elements')
    seq = await r.get(f'board:{board_id}:seq') or 0
    await sio.emit('board:snapshot', {
        'elements': {k.decode(): json.loads(v) for k, v in elements.items()},
        'lastSequence': int(seq),
    }, room=sid)

@sio.event
async def mutation_batch(sid, data):
    board_id = data['boardId']
    mutations = [
        Mutation(
            mutation_id=m['mutationId'],
            board_id=board_id,
            client_timestamp=m.get('clientTimestamp', time.time() * 1000),
            operation=m['operation'],
        )
        for m in data['mutations']
    ]

    results = await processor.process_batch(mutations, data.get('userId', sid))

    # Broadcast to others
    for result, m in zip(results, data['mutations']):
        if result['status'] != 'already_applied':
            await sio.emit('mutation', {'mutation': m}, room=board_id, skip_sid=sid)
        if result['status'] == 'applied' and result.get('change'):
            await pubsub.publish(board_id, result['change'], sid)

    # Ack
    ack_ids = [r['mutationId'] for r in results]
    seq = await r.get(f'board:{board_id}:seq') or 0
    await sio.emit('mutation:ack', {'mutationIds': ack_ids, 'sequence': int(seq)}, room=sid)

@sio.event
async def realtime_tick(sid, data):
    board_id = data['boardId']

    # Queue moves for compaction
    if data.get('moves'):
        tick.queue_moves(board_id, data.get('userId', sid), data['moves'])

    # Broadcast presence to others
    await sio.emit('realtime:tick', data, room=board_id, skip_sid=sid)

@sio.event
async def disconnect(sid):
    # Find board, remove client, persist if last
    for board_id in list(await r.smembers('boards:active')):
        bid = board_id.decode()
        member_keys = await r.smembers(f'board:{bid}:clients')
        for mk in member_keys:
            if mk.decode().endswith(f':{sid}'):
                await r.pipeline()
                    .srem(f'board:{bid}:clients', mk)
                    .delete(f'board:{bid}:client_lease:{mk}')
                    .execute()

                count = await r.scard(f'board:{bid}:clients')
                if count == 0:
                    persistence = BoardPersistenceService(r, db_pool)
                    await persistence.persist_board(bid)

async def init():
    global db_pool
    db_pool = await asyncpg.create_pool('postgresql://user:pass@localhost/mydb')

    persistence = BoardPersistenceService(r, db_pool)
    cleanup = RedisCleanupService(r, persistence)

    asyncio.create_task(persistence.start_worker(interval=30, min_dirty_age=30))
    asyncio.create_task(cleanup.start_worker(interval=120))

app = socketio.ASGIApp(sio, on_startup=init)
```

---

## Key Concepts Summary

| Concept | Implementation |
|---|---|
| **Redis as system of record** | All real-time ops hit Redis first (microseconds) |
| **SQL as durable store** | Background process flushes periodically (milliseconds) |
| **Movement compaction** | Map overwrites: only latest position per element survives |
| **Dirty element compaction** | Write current state of dirty elements, not mutation replay |
| **Debounce + max-wait** | 400ms quiet = flush, 1500ms absolute = flush |
| **Optimistic concurrency** | `dirty_epoch` Lua script prevents lost concurrent flushes |
| **Lazy load** | Board loaded from SQL to Redis on first access |
| **Eviction** | Idle boards flushed to SQL, then Redis keys deleted |
| **Catch-up sync** | Change log (2000 entries) for reconnect, full snapshot if trimmed |
| **Cross-instance sync** | Redis pub/sub channels, not Socket.IO adapter |
| **Per-board locking** | Promise chain pattern for serialization without distributed locks |
| **Distributed locking** | SET NX PX for load/eviction across instances |
| **Cascade delete** | BFS traversal of container/meta-child relationships |
| **Mutation dedup** | SET NX with 300s TTL prevents same mutation applied twice |
| **Jittered throttling** | Presence writes throttled to 3-3.4s with random jitter |

---

## Running the Python Version

```bash
pip install python-socketio redis asyncpg uvicorn

# Single instance
uvicorn main:app --host 0.0.0.0 --port 8000

# Multiple instances (load balanced)
uvicorn main:app --host 0.0.0.0 --port 8000 &
uvicorn main:app --host 0.0.0.0 --port 8001 &
```
