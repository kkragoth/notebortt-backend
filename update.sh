#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker is not installed or not in PATH."
    exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "Error: docker-compose.yml not found at $COMPOSE_FILE"
    exit 1
fi

cd "$ROOT_DIR"

echo "==> Pulling latest changes (fast-forward only)"
git pull --ff-only

echo "==> Rebuilding and restarting app services"
docker compose -f "$COMPOSE_FILE" up -d --build api realtime worker

echo "==> Running database migrations"
docker compose -f "$COMPOSE_FILE" --profile tools run --rm migrator

echo "==> Restarting nginx to ensure fresh config/certs are loaded"
docker compose -f "$COMPOSE_FILE" restart nginx

echo "==> Done"
echo "Health check:"
if [ -f "$ROOT_DIR/.env" ]; then
    # shellcheck disable=SC1091
    source "$ROOT_DIR/.env"
    if [ "${API_DOMAIN:-}" != "" ]; then
        echo "curl -i https://${API_DOMAIN}/health"
    else
        echo "API_DOMAIN not set in .env; run: curl -i https://<your-domain>/health"
    fi
else
    echo ".env not found; run: curl -i https://<your-domain>/health"
fi
