set dotenv-load

default:
    @just --list

ensure-node:
    @node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node 22+ is required. Current:', process.version); console.error('If you use nvm: nvm install 22 && nvm use 22'); process.exit(1); }"

repair-node-modules:
    @node -e "const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process'); const platform = process.platform; const arch = process.arch; const map = { darwin: { arm64: '@esbuild/darwin-arm64', x64: '@esbuild/darwin-x64' }, linux: { arm64: '@esbuild/linux-arm64', x64: '@esbuild/linux-x64' } }; const expected = map[platform]?.[arch]; if (!expected) process.exit(0); const nodeModules = path.join(process.cwd(), 'node_modules'); const expectedPath = path.join(nodeModules, expected); if (!fs.existsSync(nodeModules)) { console.log('Installing dependencies for local platform...'); execSync('npm ci', { stdio: 'inherit' }); process.exit(0); } if (fs.existsSync(expectedPath)) process.exit(0); console.log('Detected cross-platform node_modules. Reinstalling for local platform...'); fs.rmSync(nodeModules, { recursive: true, force: true }); execSync('npm ci', { stdio: 'inherit' });"

dev:
    docker compose -f docker-compose.yml --profile debug up -d --build --remove-orphans postgres redis-realtime redis-jobs adminer redis-commander
    docker compose -f docker-compose.yml run --rm backend-dev sh -lc "npm ci && npm run db:migrate"
    docker compose -f docker-compose.yml run --rm backend-dev sh -lc "npm ci && npm run db:seed"
    docker compose -f docker-compose.yml --profile dev up --build --remove-orphans backend-dev
    @echo "Backend (dev container): http://localhost:8080"
    @echo "Swagger UI: http://localhost:8080/swagger"
    @echo "OpenAPI JSON: http://localhost:8080/openapi.json"
    @echo "Adminer: http://localhost:8081"
    @echo "Redis Commander: http://localhost:8082"

dev-docker:
    docker compose -f docker-compose.yml --profile debug up -d --build --remove-orphans
    docker compose -f docker-compose.yml --profile tools run --rm migrator
    just db-seed
    @echo "Backend (via nginx): http://localhost"
    @echo "Adminer: http://localhost:8081"
    @echo "Redis Commander: http://localhost:8082"
    @docker compose -f docker-compose.yml ps

infra-up:
    docker compose -f docker-compose.yml --profile debug up -d postgres redis-realtime redis-jobs adminer redis-commander
    @echo "Waiting for services..."
    @sleep 2
    @docker compose -f docker-compose.yml ps

debug-ui-up:
    docker compose -f docker-compose.yml --profile debug up -d adminer redis-commander
    @echo "Adminer: http://localhost:8081"
    @echo "Redis Commander: http://localhost:8082"

infra-down:
    docker compose -f docker-compose.yml down

db-migrate:
    npx drizzle-kit migrate

db-generate:
    npx drizzle-kit generate

db-studio:
    npx drizzle-kit studio

db-seed:
    npx tsx src/platform/db/seed.ts

db-reset:
    docker compose -f docker-compose.yml exec postgres \
        psql -U notecanva -c "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    just db-migrate
    just db-seed

# Recreate the throwaway integration-test database from the baseline schema.
test-db:
    #!/bin/sh
    set -eu
    set -a; . ./.env; set +a
    docker compose -f docker-compose.yml up -d postgres
    i=0; until docker compose -f docker-compose.yml exec -T postgres pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && exit 1; sleep 1; done
    docker compose -f docker-compose.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP DATABASE IF EXISTS notecanva_test WITH (FORCE);" -c "CREATE DATABASE notecanva_test;"
    # drizzle-kit reads DATABASE_URL from drizzle.config.ts
    DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/notecanva_test" npx drizzle-kit migrate

test:
    just test-db
    #!/bin/sh
    set -eu
    set -a; . ./.env; set +a
    export DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/notecanva_test"
    export TEST_DATABASE_URL="$DATABASE_URL"
    npx vitest run

# Performance benchmark against locally running api + realtime apps.
# Runs against a dedicated notecanva_bench database (never the DATABASE_URL
# target) so `just bench` cannot mutate a shared/prod database via .env.
# Writes bench/results-latest.json, appends bench/bench-history.json (last 10),
# and (re)generates bench/BASELINE.md when missing or UPDATE_BASELINE=true.
bench:
    #!/bin/sh
    set -eu
    set -a; . ./.env; set +a
    docker compose -f docker-compose.yml up -d postgres redis-realtime redis-jobs
    i=0; until docker compose -f docker-compose.yml exec -T postgres pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 30 ] && exit 1; sleep 1; done
    docker compose -f docker-compose.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -c "DROP DATABASE IF EXISTS notecanva_bench WITH (FORCE);" >/dev/null 2>&1 || true
    docker compose -f docker-compose.yml exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -c "CREATE DATABASE notecanva_bench;" >/dev/null 2>&1 || true

    BENCH_DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:5432/notecanva_bench"
    # Apply the schema to the isolated bench database.
    DATABASE_URL="$BENCH_DATABASE_URL" npx drizzle-kit migrate

    API_PORT="${BENCH_API_PORT:-3100}"
    RT_PORT="${BENCH_REALTIME_PORT:-3101}"
    DATABASE_URL="$BENCH_DATABASE_URL" RATE_LIMIT_DISABLED=true LOG_LEVEL=warn PORT="$API_PORT" npx tsx src/apps/api.main.ts > /tmp/nc-bench-api.log 2>&1 &
    API_PID=$!
    DATABASE_URL="$BENCH_DATABASE_URL" RATE_LIMIT_DISABLED=true LOG_LEVEL=warn REALTIME_PORT="$RT_PORT" npx tsx src/apps/realtime.main.ts > /tmp/nc-bench-realtime.log 2>&1 &
    RT_PID=$!
    trap 'kill $API_PID $RT_PID 2>/dev/null || true' EXIT INT TERM

    wait_http() {
        i=0
        until curl -sf "http://localhost:$1/health/live" > /dev/null; do
            i=$((i+1))
            if [ "$i" -gt 60 ]; then echo "timeout waiting for :$1"; exit 1; fi
            sleep 0.5
        done
    }
    wait_http "$API_PORT"
    wait_http "$RT_PORT"

    LOG_LEVEL=warn DATABASE_URL="$BENCH_DATABASE_URL" \
        BENCH_API_URL="http://localhost:$API_PORT" \
        BENCH_REALTIME_URL="http://localhost:$RT_PORT" \
        npx tsx scripts/bench-fixture.ts

    node scripts/bench/run-bench.mjs "${BENCH_FIXTURE_OUT:-/tmp/bench-fixture.json}"

test-watch:
    npx vitest

build:
    npm run build

build-docker:
    docker compose -f docker-compose.yml build api realtime worker

health:
    @curl -s http://localhost:8080/health | python3 -m json.tool

debug-state boardId='' limit='20':
    @curl -s "http://localhost:8080/debug/state?boardId={{boardId}}&limit={{limit}}" | python3 -m json.tool

logs:
    docker compose -f docker-compose.yml logs -f

clean:
    docker compose -f docker-compose.yml down -v
    rm -rf node_modules dist

prepare:
    npm install
    docker compose -f docker-compose.yml pull

setup-ssl:
    @if [ -z "$API_DOMAIN" ] || [ -z "$LETSENCRYPT_EMAIL" ]; then \
        echo "API_DOMAIN and LETSENCRYPT_EMAIL must be set in .env"; \
        exit 1; \
    fi
    docker compose -f docker-compose.yml up -d nginx
    docker compose -f docker-compose.yml run --rm certbot \
        certonly --webroot -w /var/www/certbot \
        -d "$API_DOMAIN" \
        --email "$LETSENCRYPT_EMAIL" \
        --agree-tos --no-eff-email
    docker compose -f docker-compose.yml restart nginx

run-deploy:
    docker compose -f docker-compose.yml up -d postgres redis-realtime redis-jobs api realtime worker nginx
    docker compose -f docker-compose.yml --profile tools run --rm migrator
    docker compose -f docker-compose.yml restart nginx

deploy:
    just setup-ssl
    just run-deploy
