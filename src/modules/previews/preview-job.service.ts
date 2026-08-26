import { eq } from 'drizzle-orm';
import { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { Database } from '@/platform/db/client.js';
import type { RuntimeMetrics } from '@/platform/observability/metrics.js';
import type { BoardPreviewRenderer } from './board-preview.service.js';
import { JOB_QUEUES, createJobsQueue } from '@/platform/jobs/queues.js';
import { logger } from '@/shared/logger.js';
import { boards, elements } from '@/platform/db/schema.js';

export const PREVIEW_JOB_NAME = 'render';

export const PREVIEW_DEBOUNCE_WINDOW_MS = 90_000;
export const PREVIEW_MIN_INTERVAL_MS = 180_000;
export const PREVIEW_FLUSH_DELAY_MS = 3_000;

export interface PreviewJobData {
    boardId: string;
    flush?: boolean;
}

function parseMs(value: Date | null): number | null {
    if (!value) {
        return null;
    }
    return new Date(value).getTime();
}

// Deduplication id for the debounced render of a board.
// (BullMQ forbids ":" in custom ids, hence no colons here.)
function dedupIdFor(boardId: string): string {
    return `preview-${boardId}`;
}

function flushDedupIdFor(boardId: string): string {
    return `preview-flush-${boardId}`;
}

export function createPreviewJobService(
    db: Database,
    connection: Redis,
    renderer: BoardPreviewRenderer,
    metrics?: RuntimeMetrics,
    options: { prefix?: string } = {},
) {
    let queue: Queue<PreviewJobData> | null = null;
    let worker: Worker<PreviewJobData> | null = null;

    function getQueue(): Queue<PreviewJobData> {
        if (!queue) {
            queue = createJobsQueue<PreviewJobData>(connection, JOB_QUEUES.boardPreview, {
                prefix: options.prefix,
            });
        }
        return queue;
    }

    async function enqueue(boardId: string): Promise<{ boardId: string; dueAt: number }> {
        const dueAt = Date.now() + PREVIEW_DEBOUNCE_WINDOW_MS;
        // Native trailing-edge debounce: while a job with this dedup id is still
        // delayed, `replace` atomically swaps it for this add (fresh timer);
        // `extend` slides the dedup window so late edits can't spawn a second job.
        await getQueue().add(
            PREVIEW_JOB_NAME,
            { boardId },
            {
                deduplication: {
                    id: dedupIdFor(boardId),
                    ttl: PREVIEW_DEBOUNCE_WINDOW_MS,
                    extend: true,
                    replace: true,
                },
                delay: PREVIEW_DEBOUNCE_WINDOW_MS,
            },
        );
        return { boardId, dueAt };
    }

    async function enqueueFlush(boardId: string): Promise<{ boardId: string; dueAt: number }> {
        // Editor left the board (or tab closed): render soon after final state,
        // bypassing both the debounce and the min-interval guard.
        const dueAt = Date.now() + PREVIEW_FLUSH_DELAY_MS;
        await getQueue().add(
            PREVIEW_JOB_NAME,
            { boardId, flush: true },
            {
                deduplication: {
                    id: flushDedupIdFor(boardId),
                    ttl: PREVIEW_FLUSH_DELAY_MS,
                    extend: true,
                    replace: true,
                },
                delay: PREVIEW_FLUSH_DELAY_MS,
            },
        );
        return { boardId, dueAt };
    }

    async function maybeDeferForMinInterval(boardId: string): Promise<{ deferred: true; dueAt: number } | { deferred: false }> {
        const [board] = await db
            .select({
                previewUpdatedAt: boards.previewUpdatedAt,
            })
            .from(boards)
            .where(eq(boards.id, boardId))
            .limit(1);

        if (!board) {
            return { deferred: false };
        }

        const previewUpdatedAt = parseMs(board.previewUpdatedAt);
        if (!previewUpdatedAt) {
            return { deferred: false };
        }

        const elapsed = Date.now() - previewUpdatedAt;
        if (elapsed >= PREVIEW_MIN_INTERVAL_MS) {
            return { deferred: false };
        }

        const dueAt = previewUpdatedAt + PREVIEW_MIN_INTERVAL_MS;
        return { deferred: true, dueAt };
    }

    async function processBoardPreview(boardId: string, options: { skipMinInterval?: boolean } = {}): Promise<'updated' | 'skipped' | 'deferred'> {
        if (!options.skipMinInterval) {
            const deferred = await maybeDeferForMinInterval(boardId);
            if (deferred.deferred) {
                await getQueue().add(
                    PREVIEW_JOB_NAME,
                    { boardId },
                    {
                        deduplication: {
                            id: dedupIdFor(boardId),
                            ttl: Math.max(deferred.dueAt - Date.now(), 0),
                            extend: true,
                            replace: true,
                        },
                        delay: Math.max(deferred.dueAt - Date.now(), 0),
                    },
                );
                return 'deferred';
            }
        }

        const boardRows = await db
            .select({
                id: boards.id,
            })
            .from(boards)
            .where(eq(boards.id, boardId))
            .limit(1);

        const board = boardRows[0];
        if (!board) {
            return 'skipped';
        }

        const elementRows = await db
            .select({
                id: elements.id,
                type: elements.type,
                data: elements.data,
            })
            .from(elements)
            .where(eq(elements.boardId, boardId));

        const rendered = renderer.render(elementRows);
        const now = new Date();
        await db
            .update(boards)
            .set({
                previewSvg: rendered.svg,
                previewVersion: rendered.version,
                previewUpdatedAt: now,
            })
            .where(eq(boards.id, boardId));

        return 'updated';
    }

    async function startWorker(concurrency = 3): Promise<() => Promise<void>> {
        // Serialize re-entry: a previous close must finish before a new
        // Worker attaches to the same queue, and the stopper below must not
        // race it on the shared state.
        if (worker) {
            await worker.close();
            worker = null;
        }

        worker = new Worker<PreviewJobData>(
            JOB_QUEUES.boardPreview,
            async (job) => {
                const result = await processBoardPreview(job.data.boardId, {
                    skipMinInterval: job.data.flush === true,
                });
                if (result === 'skipped') {
                    logger.debug({ boardId: job.data.boardId }, '[PreviewJob] skipped');
                }
                return result;
            },
            { connection, ...(options.prefix ? { prefix: options.prefix } : {}), concurrency },
        );

        worker.on('failed', (job, err) => {
            metrics?.incrementCounter('bullmq_jobs_failed_total', 1, { queue: JOB_QUEUES.boardPreview });
            logger.error({ err, boardId: job?.data.boardId }, '[PreviewJob] job failed');
        });

        worker.on('error', (err) => {
            logger.error({ err }, '[PreviewJob] worker error');
        });

        return async () => {
            if (worker) {
                await worker.close();
                worker = null;
            }
            if (queue) {
                await queue.close();
                queue = null;
            }
        };
    }

    return {
        enqueue,
        enqueueFlush,
        startWorker,
        processBoardPreview,
        getQueue,
    };
}

export type PreviewJobService = ReturnType<typeof createPreviewJobService>
