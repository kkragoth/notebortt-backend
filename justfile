set dotenv-load

default:
    @just --list

dev:
    just infra-up
    just db-migrate
    npm run dev

infra-up:
    docker compose -f deploy/docker/docker-compose.yml up -d postgres redis
    @echo "Waiting for services..."
    @sleep 2
    @docker compose -f deploy/docker/docker-compose.yml ps

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
        psql -U notecanva -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    just db-migrate
    just db-seed

test:
    npx vitest run

test-watch:
    npx vitest

health:
    @curl -s http://localhost:3000/health | python3 -m json.tool

logs:
    docker compose -f deploy/docker/docker-compose.yml logs -f

clean:
    docker compose -f deploy/docker/docker-compose.yml down -v
    rm -rf node_modules dist

prepare:
    npm install
    docker compose -f deploy/docker/docker-compose.yml pull
