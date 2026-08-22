# Phase 1 — Docker Compose → Kubernetes

> Goal: run the modular monolith on Kubernetes (kind locally, a managed cluster
> for staging) with Kustomize manifests, ingress + cert-manager replacing the
> nginx/certbot containers, and migrations as Jobs.
>
> Compose stays for local dev (`just dev` unchanged). This is additive.

## Compose → K8s mapping

| Compose | K8s replacement |
|---|---|
| `backend` service | `Deployment backend-api` (role `api`, HPA 2–6 pods) |
| workers inside `backend` | `Deployment backend-worker` (same image, role `workers`) |
| `migrator` (tools profile) | `Job db-migrate` (later: ArgoCD PreSync hook — see phase 3) |
| `nginx` container | `ingress-nginx` (cluster-shared) + `Ingress` resource |
| `certbot` container + cron | `cert-manager` `ClusterIssuer` (Let's Encrypt HTTP-01, auto-renew) |
| `postgres` | staging: `CloudNativePG` or bitnami chart; prod: managed (phase 2) |
| `redis-realtime`, `redis-jobs` | two small `StatefulSet`s (staging) / managed Redis (phase 2) |
| `adminer`, `redis-commander` | gone; use `kubectl port-forward` or ephemeral debug deployments in dev overlay only |
| `.env` file | `ConfigMap` (non-secret) + `Secret`/External Secrets (secret) |

## Manifest layout (Kustomize)

```
k8s/
  base/
    kustomization.yaml
    backend-api.deployment.yaml
    backend-worker.deployment.yaml
    backend.service.yaml
    configmap.yaml
    ingress.yaml
    migrate.job.yaml
    hpa.yaml
    pdb.yaml
  overlays/
    kind/        # local: in-cluster postgres+redis, debug flags
    staging/
    prod/
```

## Key manifests (base)

### Deployment: API

```yaml
# k8s/base/backend-api.deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend-api
  labels: { app.kubernetes.io/name: note-canva, app.kubernetes.io/component: api }
spec:
  replicas: 2
  strategy:
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }   # zero-downtime
  selector:
    matchLabels: { app.kubernetes.io/name: note-canva, app.kubernetes.io/component: api }
  template:
    metadata:
      labels: { app.kubernetes.io/name: note-canva, app.kubernetes.io/component: api }
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels: { app.kubernetes.io/name: note-canva, app.kubernetes.io/component: api }
      containers:
        - name: api
          image: ghcr.io/OWNER/note-canva-backend:latest   # pinned :sha by CI
          command: ["node", "dist/index.js", "--role=api"]
          ports: [{ containerPort: 3000 }]
          envFrom:
            - configMapRef: { name: backend-config }
            - secretRef:    { name: backend-secrets }
          env:
            - name: PROCESS_ROLE
              value: api
          readinessProbe:
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:                       # add /health/live first — see notes
            httpGet: { path: /health/live, port: 3000 }
            periodSeconds: 15
          lifecycle:
            preStop:
              exec: { command: ["sleep", "5"] } # let LB drain before SIGTERM
          resources:
            requests: { cpu: 250m, memory: 512Mi }
            limits:   { cpu: "1",  memory: 1Gi }
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
```

### Deployment: Workers

Same image; different command and scaling signal. No ingress exposure.

```yaml
command: ["node", "dist/index.js", "--role=workers"]
```

Scale via HPA on a custom metric later (queue depth); start with fixed
replicas + replica-safe loops from phase 0.

### ConfigMap / Secret split of current env

| Source (`src/config.ts`) | Destination |
|---|---|
| `PORT`, `NODE_ENV`, `CORS_ORIGIN`, feature flags (`ENABLE_*`, `PRESENCE_*`) | ConfigMap |
| `DATABASE_URL`, `REDIS_REALTIME_URL`, `REDIS_JOBS_URL` | ConfigMap (hostnames) + Secret (credentials composed by ESO in phase 3; plain Secret until then) |
| `JWT_SECRET`, `GOOGLE_*`, `STRIPE_*` | Secret |

Note: today `REDIS_JOBS_URL` points at port `6380` on one host; in-cluster it is
a DNS name per StatefulSet (`redis-jobs:6379`). Zod config already tolerates this.

### Ingress + cert-manager (replaces nginx + certbot)

```yaml
# k8s/base/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backend
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-http01
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # long-lived ws
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
spec:
  ingressClassName: nginx
  tls:
    - hosts: [api.example.com]
      secretName: backend-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: backend, port: { number: 80 } } }
```

Notes vs. current nginx templates:

- Socket.IO uses websocket-only transport, so no sticky-session requirement for
  correctness of the upgrade itself; **but** presence/participant stores are
  pod-local. Multi-replica realtime needs either the Socket.IO Redis adapter or
  routing a board to one pod — tracked as a task before enabling HPA > 1 on API
  (see "Scaling caveats").
- ACME challenge path is handled automatically by cert-manager (no
  `/.well-known/acme-challenge` block, no renewal cron).

### Migrations Job

```yaml
# k8s/base/migrate.job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync       # honored once ArgoCD lands (phase 3)
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/OWNER/note-canva-backend:latest   # same image
          command: ["sh", "-lc", "npx drizzle-kit migrate"]
          envFrom:
            - secretRef: { name: backend-secrets }
```

Drizzle locks concurrent migrations at the DB level; `backoffLimit` covers
transient failures. Seed stays a manual one-off job (`--role`-less script), never
auto-applied.

## Graceful shutdown (required code change)

K8s sends SIGTERM then kills after `terminationGracePeriodSeconds`. Current
`src/index.ts` has no handler. Required behavior:

1. Stop accepting new HTTP/ws upgrades; respond `Connection: close`.
2. `io.close()` → let clients reconnect elsewhere (they already pub/sub via
   Redis for mutations).
3. Flush pending persistence ticks (persistence worker drain) — CRDT data loss
   window otherwise.
4. Stop worker loops; finish in-flight preview/persistence tasks or release
   their Redis locks.
5. Close DB/Redis pools; exit 0.

Add `/health/live` (process-only check) so a Redis blip doesn't trigger pod
restart storms — keep existing `/health` as readiness.

## Scaling caveats before raising API replicas > 1

- [ ] Presence/participants are in-memory per pod (`createParticipantsStore`);
      adopt `@socket.io/redis-adapter` (uses existing `pubRedis`) so joins and
      broadcasts work across pods.
- [ ] Heartbeat + cleanup workers already moved to `workers` deployment —
      verify no duplicated timers remain in API role.
- [ ] Load-test websocket fanout with 2 replicas (existing socketio test suite +
      `k6` scenario).

## Local workflow additions

```justfile
# kind cluster with ingress + cert-manager + local overlays
k8s-dev:
    kind create cluster --name note-canva || true
    kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
    kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
    kubectl apply -k k8s/overlays/kind
    @echo "API: http://localhost/health (after ingress port-forward)"
```

## Exit checklist

- [ ] `kubectl apply -k k8s/overlays/kind` boots full stack; `/health` OK
- [ ] Rolling update of `backend-api` drops zero established websockets
      unexpectedly (graceful shutdown verified)
- [ ] TLS issued by cert-manager; `DEPLOY.md` cron step deleted
- [ ] Migrations run as Job *before* new pods become ready
- [ ] HPA demonstrated: scale API 1→3 under load without errors
