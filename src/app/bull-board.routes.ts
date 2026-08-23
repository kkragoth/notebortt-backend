import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import type { Router } from 'express';
import type { Queue } from 'bullmq';

export const BULL_BOARD_BASE_PATH = '/admin/queues';

export function createBullBoardRouter(queues: Queue[]): Router {
    const serverAdapter = new ExpressAdapter();
    createBullBoard({
        queues: queues.map((queue) => new BullMQAdapter(queue)),
        serverAdapter,
    });
    serverAdapter.setBasePath(BULL_BOARD_BASE_PATH);
    return serverAdapter.getRouter();
}
