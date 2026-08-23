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

test:
    npx vitest run

test-watch:
    npx vitest

build:
    npm run build

build-docker:
    docker compose -f docker-compose.yml build backend

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
    docker compose -f docker-compose.yml up -d postgres redis-realtime redis-jobs backend nginx
    docker compose -f docker-compose.yml --profile tools run --rm migrator
    docker compose -f docker-compose.yml restart nginx

deploy:
    just setup-ssl
    just run-deploy
