import { MutationType } from '../mutations/types.js';
import { isMutationBlockedByLock, validateReconcileMonthRange } from '../mutations/lock-enforcement.js';
import type { BoardStateService } from '../board-state.service.js';
import type { BoardElement, Mutation, MutationResult, Operation } from '../mutations/types.js';

interface MutationProcessorOptions {
  enableTargetedReads?: boolean
}

interface CachedBoardContext {
  elementsById: Map<string, BoardElement>
}

interface ProcessMutationWithContextResult {
  result: MutationResult
  appliedCanonicalChange: boolean
}

export function createMutationProcessor(
    boardStateService: BoardStateService,
    options: MutationProcessorOptions = {},
) {
    const enableTargetedReads = options.enableTargetedReads ?? true;
    const boardMutationLocks = new Map<string, Promise<void>>();
    const metrics = boardStateService.metrics;

    async function withLocalBoardMutationLock<T>(boardId: string, task: () => Promise<T>): Promise<T> {
        const previous = boardMutationLocks.get(boardId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });

        boardMutationLocks.set(boardId, previous.then(() => current));
        await previous;

        try {
            return await task();
        } finally {
            release();
            if (boardMutationLocks.get(boardId) === current) {
                boardMutationLocks.delete(boardId);
            }
        }
    }

    async function withBoardMutationLock<T>(boardId: string, task: () => Promise<T>): Promise<T> {
        if (typeof boardStateService.withBoardMutationLock === 'function') {
            return boardStateService.withBoardMutationLock(boardId, task);
        }

        return withLocalBoardMutationLock(boardId, task);
    }

    function toUpsertFromCache(
        elementsById: Map<string, BoardElement>,
        elementId: string,
        transform: (existing: BoardElement) => BoardElement,
    ): BoardElement[] {
        const existing = elementsById.get(elementId);
        if (!existing) {
            return [];
        }

        return [transform(existing)];
    }

    function toChangeSet(
        context: CachedBoardContext,
        operation: Operation,
    ): { upserts: BoardElement[]; deletes: string[] } {
        if (operation.type === MutationType.CREATE_ELEMENT) {
            return { upserts: [operation.data], deletes: [] };
        }

        if (operation.type === MutationType.UPDATE_ELEMENT) {
            return {
                upserts: toUpsertFromCache(context.elementsById, operation.elementId, (existing) => ({
                    ...existing,
                    ...operation.fields,
                })),
                deletes: [],
            };
        }

        if (operation.type === MutationType.DELETE_ELEMENTS) {
            return { upserts: [], deletes: operation.elementIds };
        }

        if (operation.type === MutationType.MOVE_ELEMENTS) {
            const upserts = operation.moves.map((move) =>
                toUpsertFromCache(context.elementsById, move.elementId, (existing) => ({
                    ...existing,
                    x: move.x,
                    y: move.y,
                })),
            );

            return {
                upserts: upserts.flat(),
                deletes: [],
            };
        }

        if (operation.type === MutationType.UPDATE_ELEMENTS) {
            const upserts = operation.updates.map((update) =>
                toUpsertFromCache(context.elementsById, update.elementId, (existing) => ({
                    ...existing,
                    ...update.fields,
                })),
            );

            return {
                upserts: upserts.flat(),
                deletes: [],
            };
        }

        if (operation.type === MutationType.REORDER_ELEMENT) {
            return {
                upserts: toUpsertFromCache(context.elementsById, operation.elementId, (existing) => ({
                    ...existing,
                    zIndex: operation.zIndex,
                })),
                deletes: [],
            };
        }

        if (operation.type === MutationType.RECONCILE_MONTH_RANGE) {
            return { upserts: operation.upserts, deletes: operation.deletes };
        }

        return operation satisfies never;
    }

    function collectTouchedElementIds(mutations: Mutation[]): string[] {
        const ids = new Set<string>();
        for (const mutation of mutations) {
            const operation = mutation.operation;
            if (operation.type === MutationType.UPDATE_ELEMENT || operation.type === MutationType.REORDER_ELEMENT) {
                ids.add(operation.elementId);
            } else if (operation.type === MutationType.MOVE_ELEMENTS) {
                for (const move of operation.moves) {
                    ids.add(move.elementId);
                }
            } else if (operation.type === MutationType.UPDATE_ELEMENTS) {
                for (const update of operation.updates) {
                    ids.add(update.elementId);
                }
            } else if (operation.type === MutationType.RECONCILE_MONTH_RANGE) {
                // The managed meta and the months it plans to delete must be loaded so
                // integrity validation can check containment.
                ids.add(operation.metaId);
                for (const elementId of operation.deletes) {
                    ids.add(elementId);
                }
            }
        }
        return [...ids];
    }

    /** Meta layouts referenced by containment fields in CREATE/UPDATE payloads,
   *  so managed-month-range metas can be evaluated by lock enforcement. */
    function collectReferencedMetaIds(mutations: Mutation[]): string[] {
        const ids = new Set<string>();
        const consider = (fields: Partial<BoardElement> | undefined): void => {
            const metaId = fields?.metaContainerId;
            if (typeof metaId === 'string') ids.add(metaId);
        };
        for (const mutation of mutations) {
            const operation = mutation.operation;
            if (operation.type === MutationType.CREATE_ELEMENT) {
                consider(operation.data);
            } else if (operation.type === MutationType.UPDATE_ELEMENT) {
                consider(operation.fields);
            } else if (operation.type === MutationType.UPDATE_ELEMENTS) {
                for (const update of operation.updates) {
                    consider(update.fields);
                }
            }
        }
        return [...ids];
    }

    async function createCachedBoardContext(boardId: string, mutations: Mutation[]): Promise<CachedBoardContext> {
        const touchedElementIds = collectTouchedElementIds(mutations);
        if (touchedElementIds.length === 0) {
            return { elementsById: new Map<string, BoardElement>() };
        }

        const fetchByIds = async (ids: string[]): Promise<Map<string, BoardElement>> => {
            if (enableTargetedReads && typeof boardStateService.getElementsByIds === 'function') {
                const existingElements = await boardStateService.getElementsByIds(boardId, ids);
                return new Map(existingElements);
            }

            const pairs = await Promise.all(
                ids.map(async (elementId): Promise<[string, BoardElement] | null> => {
                    const existing = await boardStateService.getElement(boardId, elementId);
                    return existing ? [elementId, existing] : null;
                }),
            );

            return new Map(
                pairs.filter((entry): entry is [string, BoardElement] => entry !== null),
            );
        };

        const elementsById = await fetchByIds(touchedElementIds);

        // Load parent containers (grids / meta layouts) so lock containment can be
        // evaluated when a touched element sits inside a locked container.
        const parentIds = new Set<string>();
        for (const element of elementsById.values()) {
            const record = element as Record<string, unknown>;
            if (typeof record.containerId === 'string') parentIds.add(record.containerId);
            if (typeof record.metaContainerId === 'string') parentIds.add(record.metaContainerId);
        }
        for (const metaId of collectReferencedMetaIds(mutations)) {
            parentIds.add(metaId);
        }
        const missingParents = [...parentIds].filter((id) => !elementsById.has(id));
        if (missingParents.length > 0) {
            const parents = await fetchByIds(missingParents);
            for (const [id, element] of parents) {
                elementsById.set(id, element);
            }
        }

        return { elementsById };
    }

    function applyPersistedChangeToContext(context: CachedBoardContext, result: MutationResult): void {
        if (result.status !== 'applied' || !result.change) {
            return;
        }
        for (const element of result.change.upserts) {
            context.elementsById.set(element.id, element);
        }
        for (const deletedId of result.change.deletes) {
            context.elementsById.delete(deletedId);
        }
    }

    async function processMutationWithContext(
        mutation: Mutation,
        _userId: string,
        context: CachedBoardContext,
        writeMode: 'solo' | 'collab',
    ): Promise<ProcessMutationWithContextResult> {
        const { mutationId, boardId, operation } = mutation;

        if (operation.type === MutationType.MOVE_ELEMENTS && operation.transient) {
            return {
                result: { mutationId, status: 'broadcast_only', serverTimestamp: Date.now() },
                appliedCanonicalChange: false,
            };
        }

        const claimed = await boardStateService.tryMarkSeen(boardId, mutationId);
        if (!claimed) {
            return {
                result: { mutationId, status: 'already_applied' },
                appliedCanonicalChange: false,
            };
        }

        if (isMutationBlockedByLock(operation, context)) {
            metrics.logStructured('mutation.lock_blocked', {
                mutationId,
                boardId,
                operationType: operation.type,
            });
            return {
                result: {
                    mutationId,
                    status: 'applied',
                    serverTimestamp: Date.now(),
                    sequence: await boardStateService.peekSequence(boardId),
                },
                appliedCanonicalChange: false,
            };
        }

        if (operation.type === MutationType.RECONCILE_MONTH_RANGE) {
            const error = validateReconcileMonthRange(operation, context);
            if (error) {
                metrics.logStructured('mutation.reconcile_rejected', {
                    mutationId,
                    boardId,
                    reason: error,
                });
                return {
                    result: {
                        mutationId,
                        status: 'applied',
                        serverTimestamp: Date.now(),
                        sequence: await boardStateService.peekSequence(boardId),
                    },
                    appliedCanonicalChange: false,
                };
            }
        }

        const changeSet = toChangeSet(context, operation);
        const persistedChange = await boardStateService.applyChangeSet(boardId, changeSet, {
            trackChangeLog: writeMode === 'collab',
        });

        if (!persistedChange) {
            return {
                result: {
                    mutationId,
                    status: 'applied',
                    serverTimestamp: Date.now(),
                    sequence: await boardStateService.peekSequence(boardId),
                },
                appliedCanonicalChange: false,
            };
        }

        return {
            result: {
                mutationId,
                status: 'applied',
                serverTimestamp: persistedChange.serverTimestamp,
                sequence: persistedChange.sequence,
                change: persistedChange,
            },
            appliedCanonicalChange: true,
        };
    }

    async function processMutation(mutation: Mutation, userId: string): Promise<MutationResult> {
        return withBoardMutationLock(mutation.boardId, async () => {
            const context = await createCachedBoardContext(mutation.boardId, [mutation]);
            const writeMode = await boardStateService.getSyncWriteMode(mutation.boardId);
            const { result, appliedCanonicalChange } = await processMutationWithContext(mutation, userId, context, writeMode);
            applyPersistedChangeToContext(context, result);
            if (writeMode === 'solo' && appliedCanonicalChange) {
                await boardStateService.persistBoard(mutation.boardId);
            }
            return result;
        });
    }

    async function processBatch(mutations: Mutation[], userId: string): Promise<MutationResult[]> {
        const startedAt = Date.now();
        const results: MutationResult[] = new Array(mutations.length);
        const byBoard = new Map<string, Array<{ index: number; mutation: Mutation }>>();

        for (let index = 0; index < mutations.length; index += 1) {
            const mutation = mutations[index];
            if (!mutation) {
                continue;
            }
            const boardMutations = byBoard.get(mutation.boardId) ?? [];
            boardMutations.push({ index, mutation });
            byBoard.set(mutation.boardId, boardMutations);
        }

        for (const [boardId, boardMutations] of byBoard) {
            await withBoardMutationLock(boardId, async () => {
                const context = await createCachedBoardContext(boardId, boardMutations.map((entry) => entry.mutation));
                const writeMode = await boardStateService.getSyncWriteMode(boardId);
                let shouldPersistSolo = false;
                for (const entry of boardMutations) {
                    const { result, appliedCanonicalChange } = await processMutationWithContext(
                        entry.mutation,
                        userId,
                        context,
                        writeMode,
                    );
                    applyPersistedChangeToContext(context, result);
                    if (writeMode === 'solo' && appliedCanonicalChange) {
                        shouldPersistSolo = true;
                    }
                    results[entry.index] = result;
                }
                if (writeMode === 'solo' && shouldPersistSolo) {
                    await boardStateService.persistBoard(boardId);
                }
            });
        }

        metrics.observeTiming('mutation.process_batch_ms', Date.now() - startedAt);
        metrics.logStructured('mutation.batch', {
            batchSize: mutations.length,
            boardCount: byBoard.size,
        });

        return results;
    }

    return { processMutation, processBatch };
}

export type MutationProcessor = ReturnType<typeof createMutationProcessor>
