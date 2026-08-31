import { io } from 'socket.io-client';

const TICK_BATCH_INTERVAL_MS = 1_000;

/**
 * Socket.IO frame throughput probe: one authenticated socket joins the bench
 * board and emits realtime:tick frames at a fixed rate for durationMs, while
 * counting server events flowing back. Measures the client-observed emit rate
 * and inbound event volume — a smoke baseline, not a latency benchmark.
 */
export async function runSocketBench({ url, accessToken, boardId, elementIds, durationMs, ratePerSecond }) {
    const socket = io(url, {
        transports: ['websocket'],
        auth: { token: accessToken },
    });

    let eventsReceived = 0;
    const countInbound = () => {
        eventsReceived += 1;
    };
    socket.onAny(countInbound);

    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.disconnect();
            reject(new Error('socket connect timeout'));
        }, 10_000);
        socket.on('connect', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.on('connect_error', (err) => {
            clearTimeout(timer);
            socket.disconnect();
            reject(err);
        });
    });

    socket.emit('board:join', {
        boardId,
        sessionId: `bench-${process.pid}`,
        lastSequence: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    let tickId = 0;
    let framesEmitted = 0;
    let running = true;

    // Second socket observes the room so inbound broadcast volume is real
    // (the realtime server does not echo ticks back to their sender).
    const observer = io(url, {
        transports: ['websocket'],
        auth: { token: accessToken },
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            observer.disconnect();
            socket.disconnect();
            reject(new Error('observer connect timeout'));
        }, 10_000);
        observer.on('connect', () => {
            clearTimeout(timer);
            resolve();
        });
        observer.on('connect_error', (err) => {
            clearTimeout(timer);
            observer.disconnect();
            socket.disconnect();
            reject(err);
        });
    });
    observer.emit('board:join', {
        boardId,
        sessionId: `bench-observer-${process.pid}`,
        lastSequence: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    let broadcastTicksReceived = 0;
    observer.on('realtime:tick', () => {
        broadcastTicksReceived += 1;
    });

    const batchTimer = setInterval(() => {
        if (!running) {
            return;
        }
        // Emit one second's worth of ticks as fast as the loop allows; the
        // interval only bounds how often we refill the burst.
        for (let i = 0; i < ratePerSecond && running; i += 1) {
            tickId += 1;
            framesEmitted += 1;
            socket.emit('realtime:tick', {
                boardId,
                tickId,
                cursor: { x: tickId % 1000, y: tickId % 700 },
                selectedIds: [],
                draggedIds: [elementIds[tickId % elementIds.length]],
                focusedElementId: null,
                typingField: null,
                presenceState: 'interacting',
                presenceMessage: null,
                moves: [],
            });
        }
    }, TICK_BATCH_INTERVAL_MS);

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    running = false;
    clearInterval(batchTimer);
    socket.offAny(countInbound);
    socket.disconnect();
    observer.disconnect();

    const elapsedSeconds = durationMs / 1000;
    return {
        framesEmitted,
        emitFramesPerSecond: Math.round(framesEmitted / elapsedSeconds),
        eventsReceived,
        broadcastTicksReceived,
        observedBroadcastPerSecond: Math.round(broadcastTicksReceived / elapsedSeconds),
    };
}
