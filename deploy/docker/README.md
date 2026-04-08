# Production Deploy with Docker Compose

Everything for production is in this folder.

## 1) Edit env files

- `deploy/docker/env/postgres.env`
- `deploy/docker/env/backend.env`
- `deploy/docker/env/nginx.env`

At minimum set:
- `API_DOMAIN` in `nginx.env`
- `GOOGLE_REDIRECT_URI=https://<API_DOMAIN>/auth/callback` in `backend.env`
- real secrets (`JWT_SECRET`, Google keys, DB password)

## 2) Start stack (HTTP first)

```bash
docker compose -f deploy/docker/docker-compose.yml up -d postgres redis-realtime redis-jobs backend nginx
```

Before the first certificate is issued, nginx serves HTTP only by design.

## 3) Issue certificate

```bash
source deploy/docker/env/nginx.env

docker compose -f deploy/docker/docker-compose.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d "$API_DOMAIN" \
  --email "$LETSENCRYPT_EMAIL" \
  --agree-tos --no-eff-email
```

## 4) Switch nginx to HTTPS config

Restart nginx (it auto-detects cert files at startup):

```bash
docker compose -f deploy/docker/docker-compose.yml restart nginx
```

## 5) Run migrations

```bash
docker compose -f deploy/docker/docker-compose.yml --profile tools run --rm migrator
```

## 6) Verify

```bash
source deploy/docker/env/nginx.env
curl -i "https://$API_DOMAIN/health"
```

## 7) Renew cert (cron)

```cron
0 3 * * * cd /opt/note-canva-backend && /usr/bin/docker compose -f deploy/docker/docker-compose.yml run --rm certbot renew --webroot -w /var/www/certbot && /usr/bin/docker compose -f deploy/docker/docker-compose.yml restart nginx
```
