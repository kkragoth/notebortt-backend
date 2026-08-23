# Production Deploy with Docker Compose

Deployment files are at repository root (`docker-compose.yml`, `Dockerfile`, `nginx/templates`).

## 1) Edit root env file

- `.env` (copy from `.env.example` if needed)

At minimum set:
- `API_DOMAIN` in `.env`
- `GOOGLE_REDIRECT_URI=https://<API_DOMAIN>/auth/callback` in `.env`
- real secrets (`JWT_SECRET`, Google keys, DB password)

## 2) Start stack (HTTP first)

```bash
docker compose -f docker-compose.yml up -d postgres redis-realtime redis-jobs api realtime worker nginx
```

Before the first certificate is issued, nginx serves HTTP only by design.

## 3) Issue certificate

```bash
just setup-ssl
```

## 4) Switch nginx to HTTPS config

Restart nginx (it auto-detects cert files at startup):

`just setup-ssl` already restarts nginx after cert issuance.

## 5) Run migrations

The migrator installs devDependencies explicitly so `drizzle-kit` is available even though the main app runs with production env.

```bash
just run-deploy
```

## 6) Verify

```bash
source .env
curl -i "https://$API_DOMAIN/health"
```

## 7) Renew cert (cron)

```cron
0 3 * * * cd /opt/note-canva-backend && /usr/bin/docker compose -f docker-compose.yml run --rm certbot renew --webroot -w /var/www/certbot && /usr/bin/docker compose -f docker-compose.yml restart nginx
```

## Shortcut

`just deploy` runs:
1. `just setup-ssl`
2. `just run-deploy`
