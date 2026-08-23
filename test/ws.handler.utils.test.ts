import { describe, expect, it, vi } from 'vitest';
import { sendInitialState } from '@/modules/realtime/ws/handler.utils.js';

describe('sendInitialState', () => {
    it('sends a snapshot from the board snapshot helper when there is no prior sequence', async () => {
        const ws = {
            send: vi.fn(),
        } as any;

        const boardStateService = {
            getSnapshot: vi.fn().mockResolvedValue({
                elements: {
                    'el-1': {
                        id: 'el-1',
                        kind: 'NOTE',
                        x: 25,
                        y: 50,
                        zIndex: 1,
                        updatedAt: 123,
                    },
                },
                sequence: 7,
            }),
            getChangesAfter: vi.fn(),
        } as any;

        await sendInitialState(ws, 'board-1', 0, boardStateService, {} as any);

        expect(boardStateService.getSnapshot).toHaveBeenCalledWith('board-1');
        expect(ws.send).toHaveBeenCalledTimes(1);
        expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
            type: 'SNAPSHOT',
            elements: {
                'el-1': {
                    id: 'el-1',
                    kind: 'NOTE',
                    x: 25,
                    y: 50,
                    zIndex: 1,
                    updatedAt: 123,
                },
            },
            lastSequence: 7,
        });
    });

    it('sends catch-up changes on reconnect when log is contiguous from lastSequence', async () => {
        const ws = {
            send: vi.fn(),
        } as any;

        const boardStateService = {
            getSnapshot: vi.fn(),
            getChangesAfter: vi.fn().mockResolvedValue({
                complete: true,
                changes: [
                    {
                        sequence: 8,
                        serverTimestamp: 1700000000008,
                        upserts: [],
                        deletes: ['el-1'],
                    },
                ],
            }),
        } as any;

        await sendInitialState(ws, 'board-1', 7, boardStateService, {} as any);

        expect(boardStateService.getChangesAfter).toHaveBeenCalledWith('board-1', 7);
        expect(boardStateService.getSnapshot).not.toHaveBeenCalled();
        expect(ws.send).toHaveBeenCalledTimes(1);
        expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
            type: 'CATCH_UP',
            changes: [
                {
                    sequence: 8,
                    serverTimestamp: 1700000000008,
                    upserts: [],
                    deletes: ['el-1'],
                },
            ],
        });
    });
});
