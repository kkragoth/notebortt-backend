import { describe, expect, it, vi } from 'vitest';
import { createBoardService } from '@/services/board.service.js';

function makeBoardInvitation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'invite-1',
        boardId: 'board-1',
        invitedBy: 'user-1',
        emailLower: 'teammate@example.com',
        permission: 'edit',
        status: 'pending',
        token: 'token-1',
        expiresAt: new Date('2026-04-20T10:32:51.072Z'),
        respondedAt: null,
        createdAt: new Date('2026-04-13T10:32:51.072Z'),
        updatedAt: new Date('2026-04-13T10:32:51.072Z'),
        ...overrides,
    };
}

describe('board service invitations', () => {
    it('retries by loading the existing pending invite when insert races with a unique conflict', async () => {
        const existingInvitation = makeBoardInvitation();
        const selectLimit = vi
            .fn(async () => [])
            .mockImplementationOnce(async () => [])
            .mockImplementationOnce(async () => [{ id: existingInvitation.id, token: existingInvitation.token }]);
        const selectChain = {
            from: vi.fn(() => selectChain),
            where: vi.fn(() => selectChain),
            limit: selectLimit,
        };

        const conflictError = Object.assign(new Error('duplicate key'), { code: '23505' });
        const insertReturning = vi.fn(async () => {
            throw conflictError;
        });
        const insertChain = {
            values: vi.fn(() => insertChain),
            returning: insertReturning,
        };

        const db = {
            select: vi.fn(() => selectChain),
            insert: vi.fn(() => insertChain),
        } as any;

        const service = createBoardService(db);
        const result = await service.createBoardInvitation(
            existingInvitation.boardId,
            existingInvitation.invitedBy,
            'Teammate@Example.com',
            'edit',
        );

        expect(result).toEqual({ inviteId: existingInvitation.id, token: existingInvitation.token });
        expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('rejects accepting an invitation when the pending transition no longer succeeds', async () => {
        const invitation = makeBoardInvitation();
        const dbSelectChain = {
            from: vi.fn(() => dbSelectChain),
            where: vi.fn(() => dbSelectChain),
            limit: vi.fn(async () => [{ email: 'teammate@example.com' }]),
        };

        const txSelectChain = {
            from: vi.fn(() => txSelectChain),
            where: vi.fn(() => txSelectChain),
            limit: vi.fn(async () => [{
                id: invitation.id,
                boardId: invitation.boardId,
                invitedBy: invitation.invitedBy,
                permission: invitation.permission,
            }]),
        };
        const txUpdateChain = {
            set: vi.fn(() => txUpdateChain),
            where: vi.fn(() => txUpdateChain),
            returning: vi.fn(async () => []),
        };
        const txInsertChain = {
            values: vi.fn(() => txInsertChain),
            onConflictDoUpdate: vi.fn(async () => []),
        };

        const tx = {
            select: vi.fn(() => txSelectChain),
            update: vi.fn(() => txUpdateChain),
            insert: vi.fn(() => txInsertChain),
        };

        const db = {
            select: vi.fn(() => dbSelectChain),
            transaction: vi.fn(async (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx)),
        } as any;

        const service = createBoardService(db);

        await expect(service.acceptBoardInvitationByToken(invitation.token, 'user-2'))
            .rejects
            .toThrow('Invitation expired or already used');

        expect(tx.insert).not.toHaveBeenCalled();
    });
});
