# Kubernetes Migration Baseline

This baseline was derived from `/Users/kkragoth/Downloads/k8s-complete-guide (1).html` and adapted to the current codebase.

## What Was Implemented

1. Process roles in one image:
- `APP_ROLE=api`: runs HTTP API only.
- `APP_ROLE=realtime`: runs Socket.IO + raw WS upgrade handling.
- `APP_ROLE=worker`: runs background workers only (plus `/health` endpoint).
- `APP_ROLE=all` (default): keeps current monolith behavior.

2. Kubernetes scaffold under `k8s/`:
- `k8s/namespaces.yaml`
- `k8s/prod/configmap.yaml`
- `k8s/prod/api-deployment.yaml`
- `k8s/prod/realtime-deployment.yaml`
- `k8s/prod/worker-deployment.yaml`
- `k8s/prod/ingress.yaml`
- `k8s/prod/hpa.yaml`
- `k8s/prod/pdb.yaml`
- `k8s/prod/kustomization.yaml`
- `k8s/prod/backend-secrets.example.env`

## Why Host-Based Routing (Not Path-Based)

Current raw WebSocket endpoint is `/boards/:boardId/ws`.
API routes also use `/boards/*`, so path-based split would collide.

This baseline uses separate hosts:
- API: `api.note-canva.com`
- Realtime: `realtime.note-canva.com`

## Apply Order

```bash
kubectl apply -f k8s/namespaces.yaml
kubectl apply -f k8s/prod/configmap.yaml
kubectl create secret generic backend-secrets --namespace=prod --from-env-file=./k8s/prod/backend-secrets.env
kubectl apply -k k8s/prod
```

## Gaps To Close Before Production

1. Replace placeholder image and managed-service URLs in `k8s/prod/configmap.yaml`.
2. Add TLS certificate resources (`ManagedCertificate` or cert-manager) and wire to Ingress.
3. Update frontend env so realtime traffic goes to `realtime.<domain>`.
4. Add rollout strategy and graceful shutdown hooks if you need zero-downtime during deploy spikes.
5. Tighten secret scope per service after runtime initialization is further modularized.
