import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import autocannon from 'autocannon';
import { runSocketBench } from './socketio-bench.mjs';

const REST_DURATION_SECONDS = Number(process.env.BENCH_REST_DURATION ?? 10);
const REST_CONNECTIONS = Number(process.env.BENCH_REST_CONNECTIONS ?? 20);
const SOCKET_DURATION_MS = Number(process.env.BENCH_SOCKET_DURATION_MS ?? 10_000);
const SOCKET_RATE_PER_SECOND = Number(process.env.BENCH_SOCKET_RATE ?? 500);
const HISTORY_PATH = 'bench/bench-history.json';
const BASELINE_PATH = 'bench/BASELINE.md';
const RESULTS_LATEST_PATH = 'bench/results-latest.json';
const HISTORY_MAX_ENTRIES = 10;
const P95_REGRESSION_TOLERANCE = 0.1;

function restMutationBody(fixture) {
    // <id> is replaced by autocannon with a unique integer per request
    // (idReplacement), giving every mutation a fresh dedup key.
    return JSON.stringify({
        sessionId: 'bench',
        mutations: [{
            mutationId: 'bench-mutation-<id>',
            boardId: fixture.boardId,
            clientTimestamp: Date.now(),
            operation: {
                type: 'MOVE_ELEMENTS',
                moves: [
                    { elementId: fixture.elementIds[3], x: 120, y: 220 },
                    { elementId: fixture.elementIds[17], x: 340, y: 260 },
                ],
            },
        }],
    });
}

function percentile(result, key) {
    const value = result.latency[key];
    return typeof value === 'number' ? Math.round(value * 100) / 100 : null;
}

// Short runs may not populate every tail bucket; fall p95 → p99 (never to a
// LOWER tail like p90 — recording a smaller number into latencyP95Ms would
// bias the history/gate downward exactly when tails go missing).
function tailPercentile(result) {
    return percentile(result, 'p95') ?? percentile(result, 'p99');
}

async function runRestBench(fixture) {
    const path = `${fixture.apiPathPrefix}/boards/${fixture.boardId}/mutations`;
    const result = await autocannon({
        url: fixture.baseUrl,
        connections: REST_CONNECTIONS,
        duration: REST_DURATION_SECONDS,
        idReplacement: true,
        headers: {
            authorization: `Bearer ${fixture.accessToken}`,
            'content-type': 'application/json',
        },
        requests: [{
            path,
            method: 'POST',
            body: restMutationBody(fixture),
        }],
    });

    return {
        path,
        requestsPerSecond: Math.round(result.requests.average),
        latencyP50Ms: percentile(result, 'p50'),
        latencyP95Ms: tailPercentile(result),
        latencyP99Ms: percentile(result, 'p99'),
        totalRequests: result.requests.total,
        non2xx: result.non2xx,
        errors: result.errors,
    };
}

function rollingMedian(values) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function readHistory() {
    try {
        return JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
    } catch {
        return [];
    }
}

async function writeBaseline(results) {
    const lines = [
        '# Performance Baseline',
        '',
        `Generated: ${results.timestamp}`,
        results.gitSha ? `Commit: ${results.gitSha}` : 'Commit: (unknown)',
        '',
        '## REST mutations (POST /api/v1/boards/:id/mutations)',
        '',
        `- Throughput: **${results.rest.requestsPerSecond} req/s**`,
        `- Latency p50/p95/p99: **${results.rest.latencyP50Ms} / ${results.rest.latencyP95Ms} / ${results.rest.latencyP99Ms} ms**`,
        `- Connections: ${REST_CONNECTIONS}, duration: ${REST_DURATION_SECONDS}s`,
        '',
        '## Socket.IO frames (realtime:tick)',
        '',
        // emitFramesPerSecond counts client-side sends; the server-side token
        // bucket drops frames above its refill rate, so observedBroadcastPerSecond
        // is the honest throughput signal.
        `- Client emit rate: **${results.socket.emitFramesPerSecond} frames/s** (${results.socket.framesEmitted} sent)`,
        `- Broadcast realtime:tick frames seen by observer socket: **${results.socket.broadcastTicksReceived}** (~${results.socket.observedBroadcastPerSecond}/s, server-observed)`,
        `- Rate: ${SOCKET_RATE_PER_SECOND} frames/s burst refill every 1s (BENCH_SOCKET_RATE)`,
        '',
        'Regenerate with `UPDATE_BASELINE=true just bench`. The CI perf gate compares',
        'against the rolling median of bench-history.json (last 10 runs); >10% p95',
        'regression fails the nightly gate. PR runs are informational only.',
        '',
    ];
    await writeFile(BASELINE_PATH, lines.join('\n'));
}

function medianP95(history) {
    return rollingMedian(history
        .map((entry) => entry?.results?.rest?.latencyP95Ms)
        .filter((value) => typeof value === 'number'));
}

async function main() {
    const fixturePath = process.argv[2] ?? '/tmp/bench-fixture.json';
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

    console.error(`[Bench] REST mutations → ${fixture.baseUrl}${fixture.apiPathPrefix}/boards/:id/mutations`);
    const rest = await runRestBench(fixture);
    console.error('[Bench] Socket.IO ticks …');
    const socket = await runSocketBench({
        url: fixture.realtimeUrl,
        accessToken: fixture.accessToken,
        boardId: fixture.boardId,
        elementIds: fixture.elementIds,
        durationMs: SOCKET_DURATION_MS,
        ratePerSecond: SOCKET_RATE_PER_SECOND,
    });

    let gitSha;
    try {
        const { execFileSync } = await import('node:child_process');
        gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
    } catch {
        gitSha = undefined;
    }

    const results = {
        timestamp: new Date().toISOString(),
        gitSha,
        rest,
        socket,
    };

    await mkdir('bench', { recursive: true });
    await writeFile(RESULTS_LATEST_PATH, JSON.stringify(results, null, 2));

    const history = await readHistory();
    history.push({ timestamp: results.timestamp, gitSha, results: { rest, socket } });
    while (history.length > HISTORY_MAX_ENTRIES) {
        history.shift();
    }
    await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));

    const baselineExists = await readFile(BASELINE_PATH, 'utf8')
        .then(() => true)
        .catch(() => false);
    if (process.env.UPDATE_BASELINE === 'true' || !baselineExists) {
        await writeBaseline(results);
        console.error('[Bench] baseline written to bench/BASELINE.md');
    }

    const median = medianP95(history.slice(0, -1));
    console.log(JSON.stringify(results, null, 2));
    if (process.env.BENCH_GATE === 'true') {
        if (median === null) {
            // A gate run with no comparable history must not silently pass.
            console.error('[Bench] GATE FAILED: no bench history to compare against');
            process.exitCode = 1;
        } else {
            const threshold = median * (1 + P95_REGRESSION_TOLERANCE);
            console.error(`[Bench] gate: current p95=${rest.latencyP95Ms}ms vs rolling median=${median}ms (fail above ${threshold}ms)`);
            if (rest.latencyP95Ms > threshold) {
                console.error('[Bench] GATE FAILED: p95 regression beyond tolerance');
                process.exitCode = 1;
            }
        }
    } else if (median !== null) {
        console.error(`[Bench] informational: p95=${rest.latencyP95Ms}ms vs rolling median=${median}ms`);
    }

    if (rest.non2xx > 0 || rest.errors > 0) {
        console.error('[Bench] WARNING: non-2xx responses or connection errors during REST bench');
        if (process.exitCode !== 1) {
            process.exitCode = 1;
        }
    }
}

main().catch((err) => {
    console.error('[Bench] failed:', err);
    process.exit(1);
});
