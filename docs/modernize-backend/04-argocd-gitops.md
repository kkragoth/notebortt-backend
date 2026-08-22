# Phase 3 — ArgoCD & GitOps Delivery

> Goal: the cluster converges to git state. Deploys = commits. Rollbacks =
> reverts. No human `kubectl apply` in shared environments.

## Principles

1. **Git is the only deploy interface.** CI builds images; *it never deploys*.
   It opens a PR bumping an image tag in the GitOps source.
2. **Pull, not push.** ArgoCD watches the repo and syncs the cluster.
3. **Declarative everything**, including platform add-ons (ingress-nginx,
   cert-manager, external-secrets) — ArgoCD manages itself too.

## Repo strategy

Start **single-repo** (this one) to reduce friction; split when multiple teams/
services appear:

```
gitops/                          # moves to note-canva-gitops repo at split
  bootstrap/
    root-app.yaml                # app-of-apps entry point
  projects/
    platform.yaml
    note-canva.yaml
  apps/
    platform/
      ingress-nginx.yaml
      cert-manager.yaml
      external-secrets.yaml
    note-canva/
      staging.yaml               # Application → path k8s/overlays/staging
      prod.yaml                  # Application → path k8s/overlays/prod (auto-sync OFF)
```

## Root app (app-of-apps)

```yaml
# gitops/bootstrap/root-app.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root
  namespace: argocd
  finalizers: [resources-finalizer.argocd.argoproj.io]
spec:
  project: default
  source:
    repoURL: https://github.com/OWNER/note-canva-backend.git
    targetRevision: main
    path: gitops/apps
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated: { prune: true, selfHeal: true }
```

## Per-environment Application

```yaml
# gitops/apps/note-canva/staging.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: note-canva-staging
  namespace: argocd
spec:
  project: note-canva
  source:
    repoURL: https://github.com/OWNER/note-canva-backend.git
    targetRevision: main
    path: k8s/overlays/staging
  destination:
    server: https://kubernetes.default.svc
    namespace: note-canva
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions: [CreateNamespace=true]
    retry: { limit: 5, backoff: { duration: 15s, factor: 2 } }
```

Prod differs: `automated` disabled → sync via PR merge + manual button or
`argocd app sync` from CD with environment approval.

## Sync waves — ordering guarantees

| Wave | Content | Why |
|---|---|---|
| -2 | Namespaces, CRDs | prerequisites |
| -1 | cert-manager, ingress-nginx, external-secrets | platform deps |
| 0 | Postgres/Redis (staging) or ExternalSecrets pointing at managed instances | data layer |
| PreSync hook | `Job db-migrate` (from phase 1, annotation already set) | schema before code |
| 1 | backend-worker (consumers tolerate old+new schema) | expand/contract safety |
| 2 | backend-api | serves new schema |

The migration Job already carries `argocd.argoproj.io/hook: PreSync` +
`HookSucceeded` deletion from phase 1 — no extra work here beyond pinning wave
annotations on manifests if ordering between apps is needed:

```yaml
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "1"
```

## Image promotion flow

```
push to main
  └─ CI: just build + just test
       └─ docker build → ghcr.io/...:sha-abc1234 (immutable tag)
            └─ bot commit to k8s/overlays/staging/kustomization.yaml
                   newTag: sha-abc1234
                └─ ArgoCD auto-syncs staging
                     └─ smoke tests pass → open prod-bump PR (human review)
```

Kustomize image stanza per overlay:

```yaml
# k8s/overlays/staging/kustomization.yaml
images:
  - name: ghcr.io/OWNER/note-canva-backend
    newTag: sha-abc1234
```

Bot options: a small GitHub Action using `kustomize edit set image`, or Renovate
with regex managers. Either way the diff is auditable.

## Secrets

| Option | Verdict |
|---|---|
| Plain Secret committed | ✗ never |
| Sealed Secrets | OK, but key rotation + DR awkward |
| SOPS + age | fine for small setups, decryption keys in CI |
| **External Secrets Operator + cloud Secrets Manager** | ✓ chosen (phase 2 seeded the stores) |

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata: { name: backend-secrets, namespace: note-canva }
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secrets-manager, kind: ClusterSecretStore }
  target: { name: backend-secrets }
  data:
    - { secretKey: JWT_SECRET,     remoteKey: note-canva/staging/app, remoteProperty: jwt_secret }
    - { secretKey: DATABASE_URL,   remoteKey: note-canva/staging/app, remoteProperty: database_url }
    - { secretKey: GOOGLE_CLIENT_SECRET, remoteKey: note-canva/staging/app, remoteProperty: google_client_secret }
    # STRIPE_* likewise
```

## Operations

- **Drift:** `selfHeal: true` reverts manual changes; enable ArgoCD
  Notifications → Slack on `OutOfSync` older than 30m.
- **Rollback:** `git revert` the promotion commit (never `argocd rollback`,
  which fights self-heal).
- **Bad-image guard:** sync waves + readiness gates mean a failing rollout never
  reaches full traffic (`maxUnavailable: 0`).
- **RBAC:** AppProject restricts `note-canva` project to this repo + namespace;
  prod project requires sync windows for DB-heavy jobs if desired.

## Exit checklist

- [ ] Full stack deployable by committing only to `gitops/` paths
- [ ] Staging auto-syncs on image-bump commit; prod requires reviewed PR + sync
- [ ] Migration Job runs as PreSync and blocks app waves on failure
- [ ] Secrets arrive solely via ESO; repo grep finds no secret values
- [ ] Revert-based rollback drill executed on staging
