import type { AppConfig } from '@/shared/config.js';
import type { MetricsApp } from '@/platform/observability/metrics.js';
import type { DomainEventQueueSet } from '@/shared/events.js';
import { createDb } from '@/platform/db/client.js';
import { createRedisClient } from '@/platform/redis/client.js';
import { createRuntimeMetrics } from '@/platform/observability/metrics.js';
import {
    JOB_QUEUES,
    createDomainEventsDlqQueue,
    createJobsQueue,
} from '@/platform/jobs/queues.js';
import { createAppEventBus } from '@/shared/events.js';
import { logger } from '@/shared/logger.js';
import {
    createAuthMiddleware,
    createAuthService,
} from '@/modules/auth/index.js';
import { createUserService } from '@/modules/users/index.js';
import { createWorkspaceService } from '@/modules/workspaces/index.js';
import { createBoardService } from '@/modules/boards/index.js';
import { createBillingService } from '@/modules/billing/index.js';
import {
    createBoardPersistenceService,
    createBoardStateService,
    createMutationProcessor,
    createRedisCleanupService,
} from '@/modules/collaboration/index.js';
import {
    createBoardPreviewRenderer,
    createPreviewJobService,
} from '@/modules/previews/index.js';

export interface AppRuntimeOptions {
    /** Selects the per-app metric prefix (api_/realtime_/worker_) for default metrics. */
    app?: MetricsApp
}

/**
 * Composition root for all apps.
 *
 * Every member is a memoized lazy getter: an app pays only for what it
 * touches (api never builds persistence/cleanup workers, realtime never
 * builds billing/previews, worker skips auth/billing). Property-access
 * semantics are identical to eager construction, so call sites and types
 * are unaffected.
 */
export function createAppRuntime(config: AppConfig, options: AppRuntimeOptions = {}) {
    const cache = new Map<string, unknown>();

    function once<T>(key: string, build: () => T): T {
        if (!cache.has(key)) {
            cache.set(key, build());
        }
        return cache.get(key) as T;
    }

    const runtime = {
        get config() {
            return config;
        },

        // ── infrastructure ────────────────────────────────────────────
        get db() {
            return once('db', () => createDb(config.databaseUrl, {
                max: config.dbPoolMax,
                idleTimeoutSeconds: config.dbIdleTimeoutSeconds,
                connectTimeoutSeconds: config.dbConnectTimeoutSeconds,
                statementTimeoutMs: config.dbStatementTimeoutMs,
            }));
        },
        get redis() {
            return once('redis', () => createRedisClient(config.redisRealtimeUrl));
        },
        get pubRedis() {
            return once('pubRedis', () => createRedisClient(config.redisRealtimeUrl));
        },
        // Dedicated subscriber-mode connection for the socket.io redis adapter.
        get subRedis() {
            return once('subRedis', () => createRedisClient(config.redisRealtimeUrl));
        },
        get jobsRedis() {
            return once('jobsRedis', () => createRedisClient(config.redisJobsUrl, { maxRetriesPerRequest: null }));
        },
        /** Domain-event transport queues; null when the bus runs in-process. */
        get eventQueues(): DomainEventQueueSet | null {
            return once('eventQueues', () => {
                if (config.eventBusTransport !== 'bullmq') {
                    return null;
                }
                const prefix = config.queueRedisPrefix ?? undefined;
                return {
                    mutations: createJobsQueue(this.jobsRedis, JOB_QUEUES.domainEvents, { prefix }),
                    controlEvents: createJobsQueue(this.jobsRedis, JOB_QUEUES.domainControlEvents, { prefix }),
                    dlq: createDomainEventsDlqQueue(this.jobsRedis, { prefix }),
                };
            });
        },
        get events() {
            // In-process handlers locally; BullMQ queues carry cross-app
            // events when the apps run as separate processes
            // (EVENT_BUS_TRANSPORT=bullmq).
            return once('events', () => {
                const queues = this.eventQueues;
                if (!queues) {
                    return createAppEventBus();
                }
                return createAppEventBus({
                    transport: 'bullmq',
                    connection: this.jobsRedis,
                    prefix: config.queueRedisPrefix ?? undefined,
                    queues,
                    producerId: `${options.app ?? 'app'}-${process.pid}`,
                    onEnqueueFailed: () => this.metrics.incrementCounter('domain_events_enqueue_failed_total'),
                    onJobFailed: ({ queue, jobId, error }) => {
                        this.metrics.incrementCounter('bullmq_jobs_failed_total', 1, { queue });
                        logger.error({ err: error, queue, jobId }, '[EventBus] domain event job failed');
                    },
                });
            });
        },
        get metrics() {
            return once('metrics', () => createRuntimeMetrics({ app: options.app }));
        },

        // ── auth & domain services ────────────────────────────────────
        get authService() {
            return once('authService', () => createAuthService(config));
        },
        get authMiddleware() {
            return once('authMiddleware', () => createAuthMiddleware(this.authService));
        },
        get userService() {
            return once('userService', () => createUserService(this.db));
        },
        get workspaceService() {
            return once('workspaceService', () => createWorkspaceService(this.db));
        },
        get boardService() {
            return once('boardService', () => createBoardService(this.db));
        },
        get billingService() {
            return once('billingService', () => createBillingService(
                config, this.db, this.userService, this.workspaceService, this.boardService,
            ));
        },

        // ── collaboration & jobs ──────────────────────────────────────
        get boardStateService() {
            return once('boardStateService', () => createBoardStateService(this.redis, this.db, {
                enableIncrementalPersistence: config.enableIncrementalPersistence,
                metrics: this.metrics,
            }));
        },
        get boardPersistenceService() {
            return once('boardPersistenceService', () => createBoardPersistenceService(this.boardStateService));
        },
        get redisCleanupService() {
            return once('redisCleanupService', () => createRedisCleanupService(this.redis, this.boardStateService, {
                useActiveIndex: config.enableCleanupActiveIndex,
            }));
        },
        get boardPreviewRenderer() {
            return once('boardPreviewRenderer', () => createBoardPreviewRenderer());
        },
        get previewJobService() {
            return once('previewJobService', () => createPreviewJobService(
                this.db,
                this.jobsRedis,
                this.boardPreviewRenderer,
                this.metrics,
                { prefix: config.queueRedisPrefix ?? undefined },
            ));
        },
        get mutationProcessor() {
            return once('mutationProcessor', () => createMutationProcessor(this.boardStateService, {
                enableTargetedReads: config.enableTargetedMutationReads,
            }));
        },
    };

    return runtime;
}

export type AppRuntime = ReturnType<typeof createAppRuntime>
