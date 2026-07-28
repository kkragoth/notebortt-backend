# Note Canva — Microservices Rewrite Guide

## High-Level Architecture

### Service Boundaries

| Current Responsibility | → Microservice | Why Separate |
|---|---|---|
| Google OAuth, JWT, sessions, users | **auth-svc** | Independent lifecycle, first touchpoint |
| Board CRUD, workspaces, members, invitations, sharing | **board-mgmt-svc** (REST API) | Heavy query/command load, separate DB access patterns |
| 30s dirty-flush persistence loop (Redis → PG), mutation processing, element state | **board-state-svc** (Event-driven worker) | CPU-bound persistence logic, scales independently from API |
| WebSocket connections, rooms, presence, CRDT, broadcasting | **realtime-svc** (WebSocket server) | Long-lived connections, must scale horizontally, stateless via Redis pub/sub |
| SVG preview generation | **preview-svc** (Background worker) | CPU-intensive, can be deferred/queued |
| Stripe webhooks, subscriptions | **billing-svc** | PCI-sensitive, separate compliance boundary |
| _(new)_ LLM integration — natural language note creation, retrieval, Q&A | **agent-svc** | GPU-bound inference, needs isolation from main request path |
| _(new)_ Event bus management — schema registry, event audit, replay, dead-letter handling | **event-svc** (Event manager) | Central governance of all event flows, observability |

### Communication Patterns

```
                    ┌──────────────────────────────┐
                    │        API Gateway            │
                    │  (Kong / Traefik / Nginx)     │
                    │  /auth/*  /boards/*  /ws/*    │
                    │  /agent/*  /events/*          │
                    └──────┬──────┬────────┬────────┘
                           │      │        │
          ┌────────────────┼──────┼────────┼──────────────┐
          │                │      │        │              │
    ┌─────▼─────┐   ┌─────▼──────▼─┐  ┌───▼──────┐  ┌───▼──────┐
    │ auth-svc  │   │ board-mgmt   │  │ realtime │  │ billing  │
    │ (REST)    │   │  -svc (REST) │  │ (WS)     │  │ (REST)   │
    └───────────┘   └──────┬───────┘  └────┬─────┘  └──────────┘
                           │               │
                    ┌──────▼───────────────▼──────┐
                    │       Kafka (Event Bus)      │
                    │                              │
                    │  ┌──────────────────────┐    │
                    │  │  Schema Registry     │◄───┤  ← event-svc owns this
                    │  │  (Avro / Protobuf)   │    │
                    │  └──────────────────────┘    │
                    │                              │
                    │  Domain Topics:              │
                    │  ── board.mutation           │
                    │  ── board.state.persisted    │
                    │  ── board.lifecycle          │
                    │  ── board.membership         │
                    │  ── workspace.membership     │
                    │  ── invitation               │
                    │  ── user.lifecycle           │
                    │  ── presence                 │
                    │  ── preview                  │
                    │  ── billing                  │
                    │  ── agent.task               │
                    │  ── agent.query              │
                    │  ── agent.tool               │
                    │  ── search.index             │
                    │  ── notification             │
                    │  ── audit.log                │
                    └──────────┬───────────────────┘
                               │
          ┌────────────────────┼──────────────────────────────┐
          │                    │                              │
    ┌─────▼──────┐   ┌────────▼───────┐   ┌──────────────────▼──┐
    │ board-     │   │  event-svc     │   │     agent-svc       │
    │ state-svc  │   │ (governance)   │   │  (LLM orchestrator) │
    │ (consumer) │   │                │   │                     │
    │            │   │ • dead-letter  │   │ • tool calling      │
    └─────┬──────┘   │ • replay       │   │ • RAG pipeline      │
          │          │ • audit        │   │ • conversation mgmt │
          │          │ • schema mgmt  │   └──────────┬──────────┘
          │          └───────────────┘               │
          │                                          │
    ┌─────▼──────┐                          ┌───────▼──────────┐
    │ PostgreSQL │                          │ LLM Provider      │
    │ (elements, │                          │ (OpenAI / Claude /│
    │  mutations)│                          │  local vLLM)      │
    └────────────┘                          └───────────────────┘
```

### Key Flows

**Flow 1 — User edits a board element:**
1. Client sends mutation via WebSocket → **realtime-svc**
2. Realtime-svc validates, broadcasts to room, publishes `board.mutation` to Kafka
3. **board-state-svc** consumes `board.mutation`, applies changes to Redis, marks board dirty
4. 30s flush loop persists Redis → PostgreSQL
5. On flush complete, publishes `board.state.persisted`
6. Multiple downstream consumers react: `realtime-svc` notifies room, `search.index` consumer re-indexes, audit log consumer records

**Flow 2 — Invitation lifecycle (shows choreography saga):**
1. User creates invitation via REST → **board-mgmt-svc**
2. Board-mgmt-svc inserts invitation row, publishes `invitation.created`
3. **event-svc** stores event to audit log
4. **notification consumer** picks it up, sends email/push to invitee
5. When invitee accepts → `invitation.accepted` published
6. **board-mgmt-svc** consumer adds member to board, publishes `board.member.added`
7. **realtime-svc** consumer broadcasts `USER_JOINED` to room
8. **agent-svc** consumer could use it as context (e.g., "welcome the new member")

**Flow 3 — Natural language via AI agent:**
1. Client types "Create a sticky note saying 'Buy milk' on my Shopping board" → calls `POST /agent/v1/tasks` or sends WebSocket message
2. **agent-svc** receives the task, publishes `agent.task.created`
3. Agent-svc calls LLM with tools definition (list of backend capabilities)
4. LLM decides: call `search_boards(name="Shopping")` → agent-svc calls **board-mgmt-svc** REST API
5. LLM decides: call `create_element(boardId="...", type="note", content="Buy milk")` → agent-svc calls **board-mgmt-svc** REST or publishes `board.mutation` directly
6. Agent-svc publishes `agent.task.completed` with result + trace of tool calls
7. Result streamed back to client via WebSocket (realtime-svc) or REST response
8. `agent.tool.called` events stored for audit, debugging, and improving agent behavior

---

## Event Catalog (Complete)

Every domain event flows through Kafka. Here is the full catalog:

### User & Auth Events
| Event | Producer | Consumers | Payload Highlights |
|---|---|---|---|
| `user.registered` | auth-svc | event-svc, notification-svc, billing-svc | user_id, email, auth_provider |
| `user.logged_in` | auth-svc | event-svc, audit-svc | user_id, session_id, ip, user_agent |
| `user.logged_out` | auth-svc | event-svc | user_id, session_id |
| `user.profile.updated` | auth-svc | event-svc, search-index consumer | user_id, name, avatar_url |

### Board Lifecycle Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `board.created` | board-mgmt-svc | event-svc, agent-svc (context update) | board_id, name, workspace_id, created_by |
| `board.renamed` | board-mgmt-svc | event-svc, search-index consumer | board_id, old_name, new_name |
| `board.duplicated` | board-mgmt-svc | event-svc, board-state-svc (copy elements) | board_id, source_board_id |
| `board.deleted` | board-mgmt-svc | event-svc, board-state-svc (evict cache), realtime-svc (close rooms), search-index consumer, preview-svc | board_id, deleted_by |

### Board Mutation & State Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `board.mutation` | realtime-svc, board-mgmt-svc (REST) | board-state-svc, event-svc | board_id, user_id, mutations[], sequence, mutation_ids[] |
| `board.state.persisted` | board-state-svc | realtime-svc, event-svc | board_id, flushed_at, seq, duration_ms, element_count |
| `board.state.loaded` | board-state-svc | event-svc | board_id, loaded_at, element_count |
| `board.state.evicted` | board-state-svc (cleanup worker) | event-svc | board_id, reason (idle_timeout / board_deleted) |

### Membership & Invitation Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `invitation.created` | board-mgmt-svc | event-svc, notification consumer | invitation_id, board_id, inviter_id, invitee_email, role, expires_at |
| `invitation.accepted` | board-mgmt-svc | event-svc, board-mgmt-svc (add member), realtime-svc, agent-svc | invitation_id, board_id, user_id, role |
| `invitation.declined` | board-mgmt-svc | event-svc | invitation_id, board_id, user_id |
| `invitation.expired` | board-mgmt-svc (scheduler) | event-svc, notification consumer | invitation_id, board_id |
| `invitation.revoked` | board-mgmt-svc | event-svc | invitation_id, board_id, revoked_by |
| `board.member.added` | board-mgmt-svc | event-svc, realtime-svc (broadcast join), agent-svc | board_id, user_id, role, added_by |
| `board.member.removed` | board-mgmt-svc | event-svc, realtime-svc (broadcast leave), board-state-svc (cleanup presence) | board_id, user_id, removed_by |
| `board.member.role.updated` | board-mgmt-svc | event-svc, realtime-svc (notify) | board_id, user_id, old_role, new_role |
| `workspace.member.added` | board-mgmt-svc | event-svc | workspace_id, user_id, role |
| `workspace.member.removed` | board-mgmt-svc | event-svc, board-mgmt-svc (remove from all boards) | workspace_id, user_id |

### Presence & Real-time Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `presence.user.joined` | realtime-svc | event-svc, board-state-svc (collab mode detection) | board_id, user_id, session_id, timestamp |
| `presence.user.left` | realtime-svc | event-svc, board-state-svc (collab mode detection) | board_id, user_id, session_id, timestamp |
| `presence.heartbeat` | realtime-svc | event-svc (throttled) | board_id, user_id, active_seconds |

### Preview Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `preview.requested` | board-mgmt-svc | preview-svc, event-svc | board_id, requested_by, priority |
| `preview.generated` | preview-svc | event-svc, notification consumer | board_id, preview_url, generated_at, duration_ms |
| `preview.failed` | preview-svc | event-svc, board-mgmt-svc (retry scheduling) | board_id, error, attempt_count |

### Billing Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `billing.subscription.created` | billing-svc | event-svc, auth-svc (feature flags) | user_id, plan, period_start |
| `billing.subscription.updated` | billing-svc | event-svc, auth-svc | user_id, plan, change_type |
| `billing.subscription.canceled` | billing-svc | event-svc, auth-svc (downgrade features) | user_id, plan, effective_date |
| `billing.subscription.expired` | billing-svc (cron) | event-svc, auth-svc | user_id, prior_plan |
| `billing.payment.succeeded` | billing-svc | event-svc | user_id, amount, invoice_id |
| `billing.payment.failed` | billing-svc | event-svc, notification consumer | user_id, amount, attempt_count |

### Search & Indexing Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `search.index.board` | board-state-svc (on persist) | search-index consumer (Elasticsearch/Meilisearch) | board_id, elements[], updated_at |
| `search.index.remove` | board-mgmt-svc (on delete) | search-index consumer | board_id (or element_id) |

### Notification Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `notification.email.required` | any service | notification-svc (SendGrid/SES) | to[], subject, template, data{} |
| `notification.push.required` | any service | notification-svc (FCM/APNs) | user_id, title, body, data{} |
| `notification.in_app.required` | any service | realtime-svc (deliver to connected client) | user_id, notification_type, payload |

### Agent & AI Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `agent.task.created` | agent-svc, client (via REST/WS) | agent-svc (self), event-svc | task_id, user_id, board_id, natural_language_input, context |
| `agent.task.completed` | agent-svc | event-svc, realtime-svc (deliver to client), agent-svc (learning) | task_id, result, tool_calls[], duration_ms, tokens_used, model |
| `agent.task.failed` | agent-svc | event-svc, realtime-svc | task_id, error, partial_result |
| `agent.query.submitted` | agent-svc, client | event-svc, agent-svc (self) | query_id, user_id, board_id, query_text, filters |
| `agent.query.responded` | agent-svc | event-svc, realtime-svc, agent-svc (RAG feedback) | query_id, response, sources[], retrieval_method |
| `agent.tool.called` | agent-svc | event-svc, audit-svc (compliance) | task_id, tool_name, input, output, duration_ms |
| `agent.conversation.created` | agent-svc | event-svc | conversation_id, user_id, board_id, initial_context |
| `agent.conversation.updated` | agent-svc | event-svc | conversation_id, message_count, tokens_used_total |
| `agent.feedback.submitted` | client (thumbs up/down) | event-svc, agent-svc (fine-tuning data) | task_id, rating, user_comment |

### Audit & System Events
| Event | Producer | Consumers | Payload |
|---|---|---|---|
| `audit.log` | all services | event-svc (stores in audit table for compliance) | service, action, actor_id, resource_type, resource_id, changes{}, timestamp |
| `dead.letter` | event-svc (when consumer repeatedly fails) | event-svc, on-call alerting | original_topic, original_partition, original_offset, error, retry_count |

### Kafka Topology Summary

```
📂 Topics by retention:

  retention=∞ (compact)     ── schema._schemas, __consumer_offsets
  retention=7d              ── board.mutation, board.state.*, board.lifecycle,
                               presence.*, preview.*, billing.*, user.lifecycle,
                               search.index, notification.*
  retention=30d             ── invitation.*, board.membership, workspace.membership
  retention=90d             ── agent.*, audit.log
  retention=-1 (forever)    ── dead.letter (must be manually inspected)
```

---

## Best-Practice Monorepo Structure

```
note-canva/
├── .github/
│   └── workflows/
│       ├── ci.yml                  # Build + lint + test all services
│       ├── cd.yml                  # Deploy to k8s (dev/staging/prod)
│       └── release-please.yml      # Semantic release automation
│
├── kubernetes/
│   ├── base/                       # Kustomize base overlays
│   │   ├── namespaces/
│   │   ├── configmaps/
│   │   ├── secrets/
│   │   └── service-accounts/
│   ├── services/                   # Per-service k8s manifests
│   │   ├── auth-svc/
│   │   │   ├── deployment.yaml
│   │   │   ├── service.yaml
│   │   │   ├── hpa.yaml
│   │   │   └── service-monitor.yaml
│   │   ├── board-mgmt-svc/
│   │   ├── board-state-svc/
│   │   ├── realtime-svc/
│   │   └── preview-svc/
│   ├── overlays/                   # Environment overlays
│   │   ├── dev/
│   │   ├── staging/
│   │   └── prod/
│   └── istio/                      # Service mesh config
│       ├── virtual-services.yaml
│       ├── destination-rules.yaml
│       └── gateway.yaml
│
├── infrastructure/
│   ├── terraform/                  # IaC (if using cloud)
│   │   ├── modules/
│   │   │   ├── postgres/
│   │   │   ├── redis/
│   │   │   ├── kafka/
│   │   │   └── kubernetes/
│   │   └── environments/
│   └── helm/                       # Helm charts (alternative)
│       ├── charts/
│       │   └── note-canva/
│       └── requirements.yaml
│
├── services/                       # ← All microservices live here
│   ├── shared/                     # Shared Python lib (private package)
│   │   ├── pyproject.toml
│   │   ├── src/shared/
│   │   │   ├── __init__.py
│   │   │   ├── config/             # Base config loader
│   │   │   ├── database/           # DB client, migrations base
│   │   │   ├── messaging/          # Kafka/RabbitMQ abstractions
│   │   │   │   ├── producer.py     # Base producer with schema registry
│   │   │   │   ├── consumer.py     # Base consumer with retry + DLQ
│   │   │   │   └── schemas/        # Avro/Protobuf schemas
│   │   │   │       ├── board/
│   │   │   │       ├── invitation/
│   │   │   │       ├── agent/
│   │   │   │       └── ...
│   │   │   ├── models/             # Domain models (pydantic)
│   │   │   ├── middleware/         # FastAPI middlewares (auth, logging, tracing)
│   │   │   ├── observability/      # OpenTelemetry, Prometheus metrics
│   │   │   ├── errors/             # Custom exception hierarchy
│   │   │   └── utils/              # Helpers (ID gen, pagination, etc.)
│   │   └── tests/
│   │
│   ├── auth-svc/
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── src/auth_svc/
│   │   │   ├── __init__.py
│   │   │   ├── main.py             # FastAPI app entry point
│   │   │   ├── config.py           # Service-specific config
│   │   │   ├── api/                # Routes
│   │   │   │   ├── __init__.py
│   │   │   │   ├── v1/
│   │   │   │   │   ├── router.py   # v1 router aggregation
│   │   │   │   │   ├── google.py   # Google OAuth endpoints
│   │   │   │   │   ├── sessions.py # Login/logout/refresh
│   │   │   │   │   └── users.py
│   │   │   ├── domain/             # Business logic (no I/O deps)
│   │   │   │   ├── __init__.py
│   │   │   │   ├── entities.py     # User, Session entities
│   │   │   │   ├── events.py       # Domain events
│   │   │   │   └── services/       # Pure business logic
│   │   │   ├── application/        # Orchestration (depends on domain + ports)
│   │   │   │   ├── __init__.py
│   │   │   │   ├── auth_service.py
│   │   │   │   └── dto.py          # Data transfer objects
│   │   │   ├── infrastructure/     # Ports (DB, HTTP, messaging)
│   │   │   │   ├── __init__.py
│   │   │   │   ├── repositories/   # DB implementations
│   │   │   │   ├── messaging/      # Kafka producers/consumers
│   │   │   │   └── oauth/          # Google OAuth client
│   │   │   └── lifespan.py         # FastAPI lifespan (startup/shutdown)
│   │   └── tests/
│   │       ├── conftest.py
│   │       ├── unit/
│   │       ├── integration/
│   │       └── e2e/
│   │
│   ├── board-mgmt-svc/
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── src/board_mgmt_svc/
│   │   │   ├── main.py
│   │   │   ├── config.py
│   │   │   ├── api/
│   │   │   │   ├── v1/
│   │   │   │   │   ├── router.py
│   │   │   │   │   ├── boards.py
│   │   │   │   │   ├── workspaces.py
│   │   │   │   │   ├── members.py
│   │   │   │   │   └── invitations.py
│   │   │   ├── domain/
│   │   │   ├── application/
│   │   │   └── infrastructure/
│   │   └── tests/
│   │
│   ├── board-state-svc/            # Event-driven worker (no REST API)
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── src/board_state_svc/
│   │   │   ├── __init__.py
│   │   │   ├── main.py             # Consumer entry point
│   │   │   ├── config.py
│   │   │   ├── consumers/          # Kafka consumer handlers
│   │   │   │   ├── __init__.py
│   │   │   │   ├── mutation_consumer.py
│   │   │   │   └── persistence.py
│   │   │   ├── domain/
│   │   │   │   ├── state.py        # Element CRUD on Redis
│   │   │   │   ├── persistence.py  # Flush logic
│   │   │   │   └── events.py
│   │   │   ├── infrastructure/
│   │   │   │   ├── redis_client.py
│   │   │   │   ├── db_client.py
│   │   │   │   └── messaging.py
│   │   │   └── workers/
│   │   │       ├── flush_worker.py   # 30s interval flush
│   │   │       └── cleanup_worker.py # 2min cleanup
│   │   └── tests/
│   │
│   ├── realtime-svc/               # WebSocket server
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── src/realtime_svc/
│   │   │   ├── __init__.py
│   │   │   ├── main.py             # FastAPI + WebSocket
│   │   │   ├── config.py
│   │   │   ├── ws/                 # WebSocket handlers
│   │   │   │   ├── __init__.py
│   │   │   │   ├── connection.py   # WS lifecycle
│   │   │   │   ├── rooms.py        # In-memory room manager
│   │   │   │   └── handlers/
│   │   │   │       ├── mutation.py
│   │   │   │       ├── presence.py
│   │   │   │       ├── crdt.py
│   │   │   │       └── agent.py    # Streams agent responses to client
│   │   │   ├── domain/
│   │   │   │   ├── room.py
│   │   │   │   ├── participant.py
│   │   │   │   └── events.py
│   │   │   ├── infrastructure/
│   │   │   │   ├── redis_pubsub.py
│   │   │   │   ├── kafka_producer.py
│   │   │   │   ├── kafka_consumer.py  # Subscribes to agent.task.completed
│   │   │   │   └── auth_verifier.py
│   │   │   └── stats.py
│   │   └── tests/
│   │
│   ├── agent-svc/                  # LLM orchestrator (new)
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── src/agent_svc/
│   │   │   ├── __init__.py
│   │   │   ├── main.py             # FastAPI (REST for tasks + streaming)
│   │   │   ├── config.py
│   │   │   ├── api/
│   │   │   │   ├── v1/
│   │   │   │   │   ├── router.py
│   │   │   │   │   ├── tasks.py    # POST /tasks, GET /tasks/:id
│   │   │   │   │   ├── queries.py  # POST /queries (RAG)
│   │   │   │   │   └── conversations.py
│   │   │   ├── domain/
│   │   │   │   ├── agent.py        # Agent state, conversation, context
│   │   │   │   ├── tools.py        # Tool definitions (function calling schema)
│   │   │   │   ├── tasks.py        # Task lifecycle entity
│   │   │   │   └── events.py
│   │   │   ├── application/
│   │   │   │   ├── llm_gateway.py  # Abstraction over OpenAI/Anthropic/vLLM
│   │   │   │   ├── tool_executor.py # Routes tool calls to backend APIs
│   │   │   │   ├── rag_service.py  # Retrieval-Augmented Generation pipeline
│   │   │   │   └── conversation_service.py
│   │   │   ├── infrastructure/
│   │   │   │   ├── tool_clients/   # HTTP clients for each backend service
│   │   │   │   │   ├── board_client.py    # Calls board-mgmt-svc REST
│   │   │   │   │   ├── realtime_client.py # Publishes to realtime-svc topic
│   │   │   │   │   └── search_client.py   # Queries search index
│   │   │   │   ├── messaging/      # Kafka producers & consumers
│   │   │   │   └── vector_store.py # Embeddings + similarity search
│   │   │   └── prompts/            # Prompt templates
│   │   │       ├── system/
│   │   │       ├── tools/
│   │   │       └── rag/
│   │   └── tests/
│   │       ├── conftest.py
│   │       ├── unit/
│   │       ├── integration/        # Mock LLM responses
│   │       └── e2e/                # Real LLM calls (smoke test)
│   │
│   ├── event-svc/                  # Event governance (new)
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   ├── src/event_svc/
│   │   │   ├── __init__.py
│   │   │   ├── main.py             # FastAPI + Kafka consumer
│   │   │   ├── config.py
│   │   │   ├── api/
│   │   │   │   ├── v1/
│   │   │   │   │   ├── router.py
│   │   │   │   │   ├── audit.py    # Query audit log
│   │   │   │   │   ├── replay.py   # Trigger event replay
│   │   │   │   │   ├── dead_letter.py # Inspect/retry DLQ
│   │   │   │   │   └── schema.py   # Schema registry admin
│   │   │   ├── domain/
│   │   │   │   ├── event.py        # Event entity
│   │   │   │   ├── subscription.py # Event subscription model
│   │   │   │   └── events.py
│   │   │   ├── application/
│   │   │   │   ├── audit_service.py
│   │   │   │   ├── replay_service.py # Replay events from offset/timestamp
│   │   │   │   └── dead_letter_service.py
│   │   │   ├── infrastructure/
│   │   │   │   ├── db_client.py
│   │   │   │   └── kafka_admin.py  # Admin client for topic mgmt + replay
│   │   │   └── consumers/
│   │   │       ├── audit_consumer.py     # Stores every event to audit_log table
│   │   │       ├── dead_letter_consumer.py # Handles failed messages
│   │   │       └── metrics_consumer.py   # Event throughput/latency metrics
│   │   └── tests/
│   │
│   ├── billing-svc/
│   │   ├── pyproject.toml
│   │   ├── Dockerfile
│   │   └── src/...                 # Same hexagonal pattern
│   │
│   └── preview-svc/                # Background worker
│       ├── pyproject.toml
│       ├── Dockerfile
│       └── src/...
│
├── migration/                      # Centralized DB migrations (Alembic)
│   ├── alembic.ini
│   ├── env.py
│   ├── versions/
│   └── script.py.mako
│
├── deploy/
│   ├── docker-compose.yml          # Local dev with all services
│   ├── docker-compose.infra.yml    # PG, Redis, Kafka, Schema Registry, RabbitMQ
│   ├── docker-compose.monitoring.yml # Prometheus, Grafana, Jaeger
│   └── Makefile                    # Local dev commands
│
├── scripts/
│   ├── bootstrap-dev.sh
│   ├── seed-data.py
│   └── load-test/                  # k6 scripts
│
├── docs/
│   ├── architecture.md
│   ├── adr/                        # Architecture Decision Records
│   ├── event-catalog.md            # All domain events documented
│   └── api-specs/                  # OpenAPI specs per service
│
├── proto/                          # gRPC protos (optional, for inter-svc)
│   ├── auth/
│   ├── board/
│   └── realtime/
│
├── .pre-commit-config.yaml
├── .editorconfig
├── .gitignore
├── .dockerignore
├── ruff.toml                       # Linter (ruff)
├── pyproject.toml                  # Root (monorepo tooling config)
├── justfile                        # Task runner
└── README.md
```

---

## Technology Choices

| Layer | Choice | Why |
|---|---|---|
| **Framework** | FastAPI | Async-native, OpenAPI auto-generation, WebSocket support, top Python perf |
| **ORM** | SQLAlchemy 2.0 (async) + Alembic | Mature, async, excellent migration tooling |
| **Validation** | Pydantic v2 | FastAPI native, great perf, JSON Schema generation |
| **Message Broker** | **Kafka** (primary) + **RabbitMQ** (preview jobs) | Kafka for event log/streaming (replayable, replay, audit), RabbitMQ for task queues — shows breadth |
| **Schema Registry** | Confluent Schema Registry (Avro) or Redpanda | Enforces event contract evolution, backward compatibility — **major resume point** |
| **Cache** | Redis 7 (redis-py / aioredis) | Already in your stack, fast pub/sub for WebSocket cross-instance broadcast |
| **Auth** | Authlib (OAuth) + python-jose (JWT) | Mature OAuth/OIDC library, crypto best practices |
| **WS** | FastAPI WebSocket + python-socketio | Shows you can implement both raw WS and Socket.IO |
| **Async runtime** | uvicorn + httptools | De facto standard for async Python services |
| **LLM** | LiteLLM (uniform API for OpenAI/Anthropic/vLLM) | Swap models without code changes, supports local + cloud |
| **Vector Store** | pgvector (PostgreSQL extension) or Qdrant | RAG for note retrieval — pgvector keeps infra simple initially |
| **Embeddings** | OpenAI `text-embedding-3-small` or local `BGE` | For semantic search of notes/boards |
| **Testing** | pytest + httpx (async) + pytest-asyncio | Industry standard for FastAPI testing |
| **Container** | Docker multi-stage (slim images) | ~150MB per service with python:3.12-slim |
| **Orchestration** | Kustomize or Helm | Resume shows k8s config management |
| **Service mesh** | Istio (optional) | Traffic splitting, mTLS, observability |
| **Observability** | OpenTelemetry + Prometheus + Loki | CNCF standard stack |
| **CI/CD** | GitHub Actions + ArgoCD (GitOps) | Shows modern deployment practices |

---

## Key Architectural Decisions

### 1. Database per Service vs Shared Database
- **Initially**: shared PostgreSQL (pragmatic for learning)
- **Prepare for split**: each service touches only "its" tables
  - `board-state-svc` owns `elements`, `mutations`, `commits`
  - `board-mgmt-svc` owns `boards`, `workspaces`, `members`
  - `auth-svc` owns `users`, `oauth_accounts`, `refresh_tokens`
  - `billing-svc` owns billing tables
- Schema namespacing: `auth.*`, `board.*`, `billing.*` schemas in PG

### 2. Event Contracts
Use Avro serialization with Schema Registry — **major resume point**.
```python
# shared/src/shared/messaging/schemas/board/mutation.avsc
{
  "name": "BoardMutation",
  "type": "record",
  "fields": [
    {"name": "board_id", "type": "string"},
    {"name": "user_id",  "type": "string"},
    {"name": "mutations", "type": {"type": "array", "items": "Mutation"}},
    {"name": "timestamp", "type": "long", "logicalType": "timestamp-millis"},
    {"name": "sequence",  "type": "long"}
  ]
}
```
- Schema evolves with full backward compatibility (ADDING FIELDS with defaults)
- Breaking changes create a new subject version `board.mutation-value.v2`
- All services validate their producers/consumers against schema registry on boot

### 3. Event Versioning Strategy
| Change Type | Schema Registry Action | Consumer Impact |
|---|---|---|
| Add optional field | New version (backward compatible) | Old consumers ignore new field |
| Add required field with default | New version (backward compatible) | Default applied for old events |
| Remove field | New version (forward compatible) | Old consumers must tolerate missing field — requires compatibility mode change |
| Rename field | Deprecate old, add new (2-step migration) | Dual-write during migration window |
| Breaking change | New topic `board.mutation.v2` | Old topic retained for existing consumer replays |

### 4. Idempotency
- Mutations already have `mutationId` — use for Kafka idempotent producers + consumer dedup
- Each consumer keeps a Redis set of processed `(topic, partition, offset)` for exactly-once semantics

### 5. Saga Pattern for Distributed Transactions
- Example: user leaves board → remove membership + clean up presence + broadcast
- Choreography-based saga: `board-mgmt-svc` publishes `board.member.removed`, consumers react independently
- Each saga has an `outbox` table: published events survive service crashes (outbox + CDC pattern or transactional outbox)

### 6. Agent Tool Architecture
The agent-svc exposes tools as typed functions that map to backend operations:

```
Agent tools (defined in agent-svc/src/domain/tools.py):
├── search_boards(query, workspace_id?)        → board-mgmt-svc REST
├── get_board_elements(board_id)                → board-state-svc / board-mgmt-svc
├── create_element(board_id, type, content, position)  → publishes board.mutation
├── update_element(board_id, element_id, changes)      → publishes board.mutation
├── delete_element(board_id, element_id)               → publishes board.mutation
├── search_notes(query, board_id?, user_id?)           → search index
├── get_board_members(board_id)                        → board-mgmt-svc REST
├── invite_user(board_id, email, role)                 → board-mgmt-svc REST
├── list_user_boards()                                 → board-mgmt-svc REST
└── ask_about_boards(question, board_ids[])             → RAG pipeline (embeddings + LLM)
```

Each tool call is published as `agent.tool.called` for audit. The LLM sees these tool definitions as JSON Schema function-calling descriptions.

---

## Resume-Worthy Practices

| Practice | How to Show It |
|---|---|
| **Event-driven** | 20+ domain event types across 10 topics, Avro schema registry, event replay for state rebuild |
| **CQRS** | Separate read/query (board-mgmt-svc REST) from write (board-state-svc via events) |
| **Event Sourcing-lite** | All state changes flow through Kafka; `event-svc` provides replay to rebuild any service's state |
| **Choreography Sagas** | Invitation lifecycle spans 4 services via events, no central orchestrator needed |
| **Hexagonal Architecture** | Domain layer has zero I/O deps; infrastructure injected via ports/adapter pattern |
| **AI + Event-Driven** | Agent-svc consumes/publishes domain events, LLM tool calls flow through Kafka, RAG pipeline |
| **Observability** | Distributed tracing across all services with OpenTelemetry, structured JSON logging, Prometheus metrics per endpoint |
| **K8s Native** | Health/liveness/readiness probes, HPA based on CPU/custom metrics, PodDisruptionBudgets, resource requests/limits |
| **GitOps** | ArgoCD syncs from repo → cluster, PR-based deployments |
| **Security** | Zero-trust: mTLS between services (Istio), JWT validation in API gateway, secret management (External Secrets Operator) |
| **Testing** | Unit (domain logic), integration (with testcontainers for PG/Redis/Kafka), contract tests (Pact), e2e |
| **API Versioning** | `/api/v1/...` from day one, deprecation headers |

---

## Suggested Learning Path

| Week | Focus | Deliverable |
|---|---|---|
| 1 | Monorepo scaffold + infra | `docker-compose.infra.yml` (PG, Redis, Kafka, Schema Registry), `shared/` package, **auth-svc** with FastAPI + Google OAuth + Alembic |
| 2 | Board management REST | **board-mgmt-svc** — board/workspace/member CRUD, SQLAlchemy async, OpenAPI docs, publish first events (`board.created`, `board.member.added`) |
| 3 | Event streaming foundation | Avro schemas for all board/invitation/ membership events, **event-svc** — audit logging, dead letter queue, replay endpoint |
| 4 | State + persistence worker | **board-state-svc** — consume `board.mutation`, Redis state management, 30s flush loop migrated from TS, publish `board.state.persisted` |
| 5 | Real-time | **realtime-svc** — FastAPI WebSocket, room manager, Redis pub/sub, Kafka producer for mutations, consumer for `board.state.persisted` |
| 6 | Invitation saga | Full invitation lifecycle via events: `invitation.created` → email → `invitation.accepted` → `board.member.added` → realtime broadcast |
| 7 | AI agent — basic | **agent-svc** — LLM gateway, tool definitions (search_boards, create_element), `agent.task.created`/`completed`, RAG with pgvector |
| 8 | AI agent — advanced | Conversation management, streaming agent responses through realtime-svc, `agent.tool.called` audit, feedback collection |
| 9 | Background workers | **preview-svc** + **billing-svc** on RabbitMQ, subscribe to domain events where relevant |
| 10 | Containerization + K8s | Docker multi-stage for all services, Kustomize/Helm manifests, local Kind cluster |
| 11 | Service mesh + observability | Istio, OpenTelemetry traces, Prometheus + Grafana dashboards, ArgoCD |
| 12 | CI/CD + hardening | GitHub Actions pipelines, load testing (k6), chaos engineering |
