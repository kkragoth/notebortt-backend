# Backend Modernization: Docker Compose → Kubernetes / Terraform / ArgoCD

This directory is the working plan for moving note-canva-backend from a
single-host Docker Compose deployment to a GitOps-managed Kubernetes platform,
without breaking the app along the way.

**Strategy in one line:** restructure as a *modular monolith* first, lift it to
Kubernetes, codify infrastructure with Terraform, hand delivery to ArgoCD — and
only then introduce message brokers (RabbitMQ for jobs, Kafka for domain events)
where they pay for themselves.

A hostile pass over these plans lives in
[`review-adversarial.md`](./review-adversarial.md); its critical/high findings
are already folded into the phase docs below.

## Premise gates (must pass before Phase 2)

The current stack is one VPS (~$20/mo). The target stack is roughly **$500–800+/mo**
(EKS or GKE + managed Postgres + 2× Redis + NAT), plus on-call surface. Before
spending Terraform money, write down:

1. **SLOs** — availability target, acceptable realtime reconnect rate, max CRDT
   flush data-loss window (RPO). Exit criteria below are outcome-based against
   these numbers.
2. **Budget sign-off** — monthly ceiling approved by whoever pays.
3. **Lighter-path check** — if SLOs can be met on a single managed cluster
   (k3s/DigitalOcean/OKE) or a PaaS (Fly/Railway) *without* Terraform+ArgoCD,
   that is a legitimate outcome of this plan, not a failure. EKS-class tooling
   is justified by multi-env needs, compliance, or team growth — not by default.

## Current State Audit

What `docker-compose.yml` gives us today:

| Compose service | Purpose | Pain point at scale |
|---|---|---|
| `postgres` (17-alpine) | Primary datastore (Drizzle ORM) | Single host, manual backups, no HA |
| `redis-realtime` (:6379) | Presence, dirty-board tracking, mutation pub/sub (`board:{id}:mutations`) | Co-located with app host |
| `redis-jobs` (:6380) | Preview render jobs (ZSET `preview:jobs:due`), locks | Same |
| `backend` | Express 5 API + Socket.IO + raw ws + **3 in-process workers** (persistence, redis-cleanup, preview) + heartbeat | CPU-bound preview rendering competes with websocket traffic; cannot scale independently |
| `migrator` (tools profile) | `drizzle-kit migrate` via node:22-alpine container (`npm ci --include=dev`) | Manual step, run by hand |
| `nginx` + `certbot` | TLS termination, Let's Encrypt webroot + cron renew | Hand-rolled config templates, cert renewal cron on host |
| `adminer`, `redis-commander` (debug profile) | Local debug UIs | N/A in prod |
| `backend-dev` (dev profile) | Hot-reload dev container | Local-only |

Facts that shape the plan:

- `/health` aggregates Postgres + Redis + dirty-backlog status — too heavy for a
  readiness probe (see phase 1); lighter probes must be added first.
- Socket.IO runs **websocket-only** and mutations fan out via Redis pub/sub;
  presence/participant stores are pod-local, and the **raw-ws stack** has its own
  pub/sub path — multi-replica realtime needs work beyond adding replicas.
- No SIGTERM handler yet — required for safe Kubernetes pod eviction.
- All env validated by Zod in `src/config.ts` — maps cleanly to k8s env.
- `drizzle-kit` is a devDependency; the runtime image cannot run migrations as-is
  (fixed in phase 1 by moving it to production deps).

## Target Architecture

```
                        ┌────────────────────────── GitOps repo ──────────────────────────┐
                        │  desired state: k8s overlays (dev / staging / prod)             │
                        └───────────────▲─────────────────────────────────────────────────┘
                                        │ ArgoCD sync (pull)
┌───────────── Terraform ───────────────┼──────────────────────────────────────────────┐
│  VPC / cluster · RDS Postgres 17      │        ┌────────── Kubernetes cluster ───────┐
│  ElastiCache Redis ×2                 │        │ ingress-nginx + cert-manager (TLS)  │
│  Secrets Manager · Route53 · IRSA     │        │                                     │
└───────────────────────────────────────┘        │ [Deployment] backend-api (HPA-gated)│
                                                 │ [Deployment] backend-worker         │
   CI: build → push :sha → bump overlay ──────►  │   (KEDA-scaled on queue depth)      │
                                                 │ [initContainer] db-migrate w/ lock  │
                                                 │ redis-realtime / redis-jobs         │
                                                 │ Phase 4+: RabbitMQ, then Kafka      │
                                                 └─────────────────────────────────────┘
```

## Phased Roadmap

Each phase has hard exit criteria. Do not start phase N+1 until N's gates pass.

| Phase | Doc | Goal | Key exit criteria |
|---|---|---|---|
| 0 | [`01-modular-monolith.md`](./01-modular-monolith.md) | Enforce module seams on the **current** layout; split API vs worker processes via `PROCESS_ROLE`; add `EventBus` port | arch-lint green in CI; both roles boot against compose stack; all background loops claim-safe across replicas |
| 1 | [`02-kubernetes.md`](./02-kubernetes.md) | K8s manifests (Kustomize), kind locally, ingress + cert-manager replace nginx/certbot | stack runs on kind & staging; migration ordering proven empirically (initContainer); reconnect-loss measured under rolling update |
| 2 | [`03-terraform.md`](./03-terraform.md) | Cloud infra as code — **only after premise gates pass** | staging reproducible from scratch <30 min; PITR restore drill done; compose deploy recipes retired |
| 3 | [`04-argocd-gitops.md`](./04-argocd-gitops.md) | GitOps delivery, promotion via PRs to a `releases/prod` ref | deploys happen only via commits; revert-based rollback drill passes under expand/contract rule |
| 4 | [`05-message-brokers.md`](./05-message-brokers.md) | RabbitMQ for commands → Kafka for events | preview pipeline on RMQ w/ DLQ alarms in prod; ≥1 Kafka event consumed end-to-end with lag <10s |

## Decisions Log (mini-ADRs)

| # | Decision | Rationale |
|---|---|---|
| ADR-1 | Modular monolith before any service split | Team size + shared CRDT state; split later along proven seams |
| ADR-2 | One image, two process roles selected by **`PROCESS_ROLE` env var** (`api`\|`workers`\|`all`) | Independent scaling without code duplication; env var works uniformly in compose/k8s/local |
| ADR-3 | Managed Postgres + Redis over in-cluster operators for prod | Backup/failover burden; **RPO decision:** staging accepts realtime-Redis loss ≤ persistence-flush interval; prod requires managed Redis with AOF `everysec` and a monitored flush-interval SLO |
| ADR-4 | cert-manager replaces certbot+cron entirely | Declarative, auto-renewing, per-ingress |
| ADR-5 | Single repo until phase 3, then separate GitOps repo | Blast-radius separation when it actually matters |
| ADR-6 | RabbitMQ first (commands), Kafka second (events) | Jobs need routing/DLQ/per-job ACK now; streaming demand comes later |
| ADR-7 | Keep Redis pub/sub for live board fanout indefinitely | Sub-ms ephemeral fanout; brokers add latency for zero durability benefit here |
| ADR-8 | Migrations run in an **initContainer holding a Postgres advisory lock**, not k8s Jobs | Plain Kustomize has no hook mechanism; ordering is guaranteed per-pod and verifiable without ArgoCD. Re-evaluate PreSync hooks only after phase 3 lands |
| ADR-9 | **Expand/contract schema discipline**: every migration must run cleanly against the previous release's code | Makes git-revert rollbacks safe; destructive changes require a two-release dance |
| ADR-10 | Preview delays use the `rabbitmq_delayed_message_exchange` plugin | Per-message TTL→DLX dead-lettering blocks head-of-line with variable delays (90s debounce vs up-to-180s deferrals) |

## Conventions

- Layout until the GitOps split: `k8s/` (Kustomize base + overlays),
  `infra/terraform/`, `gitops/`, `scripts/` (state bootstrap, secrets write).
- Local dev keeps Docker Compose (`just dev`). Kubernetes local work targets `kind`.
- **Supply chain:** images are pushed as immutable `:sha-<gitsha>` tags and
  verified (cosign) at admission; third-party addon URLs are version-pinned.
- **Compose deploy recipes are deprecated at phase-2 cutover**: `just deploy`,
  `setup-ssl`, `run-deploy` get deleted once staging serves traffic from the
  new path — no dual sources of truth past that gate.
