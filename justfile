set dotenv-load

default:
    @just --list

ensure-node:
    @node -e "const major = Number(process.versions.node.split('.')[0]); if (major < 20) { console.error('Node 20+ is required. Current:', process.version); console.error('Run: nvm install 22 && nvm use 22'); process.exit(1); }"

repair-node-modules:
    @node -e "const fs = require('fs'); const path = require('path'); const platform = process.platform; const arch = process.arch; const map = { darwin: { arm64: '@esbuild/darwin-arm64', x64: '@esbuild/darwin-x64' }, linux: { arm64: '@esbuild/linux-arm64', x64: '@esbuild/linux-x64' } }; const expected = map[platform]?.[arch]; if (!expected) process.exit(0); const nodeModules = path.join(process.cwd(), 'node_modules'); if (!fs.existsSync(nodeModules)) process.exit(10); const expectedPath = path.join(nodeModules, expected); if (fs.existsSync(expectedPath)) process.exit(0); console.log('Repairing node_modules for', platform + '/' + arch, 'expected', expected); process.exit(11);"
    @status=$$?; if [ $$status -eq 10 ]; then \
        echo "Installing dependencies for local platform..."; \
        npm ci; \
    elif [ $$status -eq 11 ]; then \
        echo "Detected cross-platform node_modules. Reinstalling for local platform..."; \
        rm -rf node_modules; \
        npm ci; \
    elif [ $$status -ne 0 ]; then \
        exit $$status; \
    fi

dev:
    just ensure-node
    just repair-node-modules
    just infra-up
    just debug-ui-up
    just db-migrate
    @echo "Swagger UI: http://localhost:8080/swagger"
    @echo "OpenAPI JSON: http://localhost:8080/openapi.json"
    @echo "Adminer: http://localhost:8081"
    @echo "Redis Commander: http://localhost:8082"
    npm run dev

infra-up:
    docker compose -f deploy/docker/docker-compose.yml --profile debug up -d postgres redis adminer redis-commander
    @echo "Waiting for services..."
    @sleep 2
    @docker compose -f deploy/docker/docker-compose.yml ps

debug-ui-up:
    docker compose -f deploy/docker/docker-compose.yml --profile debug up -d adminer redis-commander
    @echo "Adminer: http://localhost:8081"
    @echo "Redis Commander: http://localhost:8082"

infra-down:
    docker compose -f deploy/docker/docker-compose.yml down

db-migrate:
    npx drizzle-kit migrate

db-generate:
    npx drizzle-kit generate

db-studio:
    npx drizzle-kit studio

db-seed:
    npx tsx src/db/seed.ts

db-reset:
    docker compose -f deploy/docker/docker-compose.yml exec postgres \
        psql -U notecanva -c "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    just db-migrate
    just db-seed

test:
    npx vitest run

test-watch:
    npx vitest

health:
    @curl -s http://localhost:8080/health | python3 -m json.tool

debug-state boardId='' limit='20':
    @curl -s "http://localhost:8080/debug/state?boardId={{boardId}}&limit={{limit}}" | python3 -m json.tool

logs:
    docker compose -f deploy/docker/docker-compose.yml logs -f

clean:
    docker compose -f deploy/docker/docker-compose.yml down -v
    rm -rf node_modules dist

prepare:
    npm install
    docker compose -f deploy/docker/docker-compose.yml pull
