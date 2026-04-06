# Backend Debugging

## SQL

Use Drizzle Studio for the schema defined in [src/db/schema.ts](/Users/kkragoth/dev/note-canva-backend/src/db/schema.ts):

```bash
cd /Users/kkragoth/dev/note-canva-backend
docker compose -f deploy/docker/docker-compose.yml up -d postgres
npm run db:migrate
npm run db:studio
```

Open the URL printed by Drizzle Studio, usually `http://localhost:4983`.

If you want a simple Docker-hosted SQL browser instead:

```bash
just debug-ui-up
```

Open `http://localhost:8081` and connect with:

- system: `PostgreSQL`
- server: `postgres` when using Docker network, or `localhost` from host
- username: `notecanva`
- password: `localdev`
- database: `notecanva`

## Redis

Start the debug UIs:

```bash
just debug-ui-up
```

Open `http://localhost:8082`.

That UI is backed by the `redis` service from [deploy/docker/docker-compose.yml](/Users/kkragoth/dev/note-canva-backend/deploy/docker/docker-compose.yml).

## App Debug Endpoint

The backend now exposes a dev-only debug endpoint:

```bash
curl "http://localhost:8080/debug/state"
curl "http://localhost:8080/debug/state?boardId=<board-id>"
```

Or with the provided `just` command:

```bash
just debug-state
just debug-state <board-id> 50
```

The response includes:

- Postgres row counts for core tables
- recently updated boards
- Redis memory summary
- sampled board keys
- per-board Redis state such as `seq`, client count, element count, and last activity
