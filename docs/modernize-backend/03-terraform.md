# Phase 2 — Terraform: Infrastructure as Code

> Goal: the cluster and its dependencies (network, managed Postgres/Redis, IAM,
> DNS, secrets plumbing) are reproducible from code. No console clicks.
>
> Examples target AWS (EKS + RDS + ElastiCache). GCP/Azure equivalents are noted
> inline; module interfaces stay provider-neutral where practical.

## Layout

```
infra/terraform/
  modules/
    network/          # VPC, subnets (multi-AZ), NAT, endpoints
    eks/              # control plane + managed node groups + addons
    rds-postgres/     # Postgres 17, multi-AZ, backup/pitr
    elasticache-redis/# two clusters: realtime + jobs (matches today's split)
    irsa-app/         # IRSA role bound to backend K8s service account
    dns/              # Route53 zone/records for API_DOMAIN
  envs/
    staging/
      main.tf versions.tf outputs.tf backend.tf
    prod/
```

Remote state per env (S3 + DynamoDB lock; or HCP/Terraform Cloud):

```hcl
# envs/staging/backend.tf
terraform {
  backend "s3" {
    bucket         = "note-canva-tfstate"
    key            = "staging/terraform.tfstate"
    region         = "eu-central-1"
    dynamodb_table = "note-canva-tflock"
    encrypt        = true
  }
}
```

## Version pins

```hcl
# envs/staging/versions.tf
terraform {
  required_version = "~> 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
    tls = { source = "hashicorp/tls", version = "~> 4.0" }
  }
}
```

## What Terraform owns vs what Kubernetes owns

| Concern | Owner |
|---|---|
| VPC, subnets, routes | `modules/network` |
| EKS cluster, node groups, core addons (vpc-cni, ebs-csi) | `modules/eks` |
| RDS instance, ElastiCache clusters, security groups | data modules |
| IRSA roles for `backend-api`/`backend-worker` SAs, external-secrets, aws-load-balancer-controller, external-dns | `modules/irsa-app` |
| Route53 record for `API_DOMAIN` → ingress LB | `modules/dns` |
| Deployments/Ingress/etc. | K8s manifests (phase 1) via ArgoCD (phase 3) |
| App-level secrets values | Secrets Manager entries seeded here, synced by ESO |

## Representative module wiring

```hcl
# envs/staging/main.tf (excerpt)
module "network" {
  source       = "../../modules/network"
  cidr_block   = "10.40.0.0/16"
  az_count     = 3
}

module "eks" {
  source          = "../../modules/eks"
  cluster_name    = "note-canva-staging"
  subnet_ids      = module.network.private_subnet_ids
  node_groups = {
    apps = { instance_types = ["m7g.large"], min_size = 2, max_size = 6, desired_size = 2 }
  }
}

module "postgres" {
  source            = "../../modules/rds-postgres"
  identifier        = "note-canva-staging"
  engine_version    = "17"
  instance_class    = "db.t4g.medium"
  multi_az          = false          # true in prod
  subnet_ids        = module.network.data_subnet_ids
  allowed_sg_ids    = [module.eks.node_security_group_id]
  storage_encrypted = true
}

module "redis_realtime" {
  source         = "../../modules/elasticache-redis"
  cluster_id     = "realtime-staging"
  node_type      = "cache.t4g.small"
  subnet_ids     = module.network.data_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
}

module "redis_jobs" {
  source         = "../../modules/elasticache-redis"
  cluster_id     = "jobs-staging"
  node_type      = "cache.t4g.micro"
  subnet_ids     = module.network.data_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
}
```

Keeping **two Redis clusters** mirrors today's `REDIS_REALTIME_URL` /
`REDIS_JOBS_URL` isolation (a runaway preview backlog can't starve pub/sub).
Revisit consolidation later — it's a config change thanks to Zod config.

## IAM for Pods (IRSA) instead of static credentials

```hcl
module "irsa_backend" {
  source            = "../../modules/irsa-app"
  cluster_oidc_arn  = module.eks.oidc_provider_arn
  namespace         = "note-canva"
  service_account   = "backend"
  policy_statements = {
    s3_previews = {
      actions   = ["s3:GetObject", "s3:PutObject"]
      resources = ["arn:aws:s3:::note-canva-previews/*"]
    }
  }
}
```

The app never receives AWS keys; long-lived app secrets (JWT, Google, Stripe,
DB URL) flow through Secrets Manager:

```hcl
resource "aws_secretsmanager_secret" "app_secrets" { name = "note-canva/staging/app" }

# Values are written once out-of-band or via a one-time script;
# Terraform creates the container, ESO (phase 3) syncs contents into k8s Secret
# `backend-secrets`. tfstate never contains secret *values*.
```

## DNS

`external-dns` (installed via ArgoCD later) reads Ingress hosts and writes
Route53 records using an IRSA role from `modules/dns`. Delete the manual
"point DNS at VPS" step from DEPLOY.md.

## CI workflow (no laptop applies)

`.github/workflows/terraform.yml`:

1. PR → `fmt -check`, `init`, `validate`, `plan` (per env dir); plan posted to PR.
2. Merge to main with label `apply:staging` → `apply` on staging.
3. Prod apply requires environment approval (GitHub Environments).

Scheduled nightly `plan` on prod for drift detection; alert on non-empty diff.

## Migration of existing state

Current host runs everything in Docker. Cutover order:

1. Provision infra (Terraform) — new managed Postgres/Redis.
2. `pg_dump` from compose Postgres → restore into RDS (maintenance window).
3. Re-seed Redis caches implicitly (they're rebuildable; preview ZSET re-enqueues
   naturally on next board edit).
4. Point staging overlay URLs at new hosts; run phase-1 stack against them.
5. Decommission single host after parity checks (`just health`, socketio tests).

GCP alternative: GKE Autopilot / Cloud SQL / Memorystore.
Azure alternative: AKS / Azure Database for PostgreSQL / Azure Cache for Redis.

## Exit checklist

- [ ] `envs/staging` applies green from empty cloud account
- [ ] Nightly drift plan clean for 7 days
- [ ] App pods authenticate via IRSA (no AWS keys anywhere in k8s)
- [ ] Restore-from-backup drill executed on RDS (PITR)
- [ ] Prod env code reviewed & applied behind approvals
