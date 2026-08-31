#!/bin/sh
# CI counterpart of `just bench`: boots api + realtime against the workflow's
# postgres/redis services, prepares the fixture, runs the benchmark suite.
# Usage: scripts/ci-bench.sh informational|gate
set -eu

MODE="${1:-informational}"
API_PORT="${BENCH_API_PORT:-3100}"
RT_PORT="${BENCH_REALTIME_PORT:-3101}"
FIXTURE_OUT="${BENCH_FIXTURE_OUT:-/tmp/bench-fixture.json}"

PGUSER_DEFAULT=notecanva
PGPASSWORD_DEFAULT=notecanva

# Idempotent bench-database bootstrap. Only "already exists" is tolerated;
# auth/connection failures must fail loudly instead of surfacing later as a
# confusing migrate error.
create_out="$(PGPASSWORD="$PGPASSWORD_DEFAULT" psql -h localhost -U "$PGUSER_DEFAULT" -d notecanva_test \
    -c 'CREATE DATABASE notecanva_bench;' 2>&1)" || {
    case "$create_out" in
        *"already exists"*) ;;
        *)
            echo "ci-bench: CREATE DATABASE failed: $create_out" >&2
            exit 1
            ;;
    esac
}

export DATABASE_URL="postgres://$PGUSER_DEFAULT:$PGPASSWORD_DEFAULT@localhost:5432/notecanva_bench"

# Apply the schema to the bench database (created fresh by CI each run).
DATABASE_URL="$DATABASE_URL" npx drizzle-kit migrate

RATE_LIMIT_DISABLED=true LOG_LEVEL=warn PORT="$API_PORT" npx tsx src/apps/api.main.ts > /tmp/nc-bench-api.log 2>&1 &
API_PID=$!
RATE_LIMIT_DISABLED=true LOG_LEVEL=warn REALTIME_PORT="$RT_PORT" npx tsx src/apps/realtime.main.ts > /tmp/nc-bench-realtime.log 2>&1 &
RT_PID=$!
trap 'kill $API_PID $RT_PID 2>/dev/null || true' EXIT INT TERM

wait_http() {
    i=0
    until curl -sf "http://localhost:$1/health/live" > /dev/null; do
        i=$((i+1))
        if [ "$i" -gt 60 ]; then
            echo "timeout waiting for :$1" >&2
            tail -50 "/tmp/nc-bench-api.log" /tmp/nc-bench-realtime.log || true
            exit 1
        fi
        sleep 0.5
    done
}
wait_http "$API_PORT"
wait_http "$RT_PORT"

BENCH_API_URL="http://localhost:$API_PORT" \
BENCH_REALTIME_URL="http://localhost:$RT_PORT" \
BENCH_FIXTURE_OUT="$FIXTURE_OUT" \
npx tsx scripts/bench-fixture.ts

if [ "$MODE" = "gate" ]; then
    BENCH_GATE=true node scripts/bench/run-bench.mjs "$FIXTURE_OUT"
else
    BENCH_GATE=false node scripts/bench/run-bench.mjs "$FIXTURE_OUT"
fi
