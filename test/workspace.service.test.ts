import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceService } from '../src/services/workspace.service.js'

function makeInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    workspaceId: 'workspace-1',
    invitedBy: 'user-1',
    email: 'teammate@example.com',
    emailLower: 'teammate@example.com',
    role: 'viewer',
    status: 'pending',
    token: 'token-1',
    expiresAt: new Date('2026-04-20T10:32:51.072Z'),
    respondedAt: null,
    createdAt: new Date('2026-04-13T10:32:51.072Z'),
    updatedAt: new Date('2026-04-13T10:32:51.072Z'),
    ...overrides,
  }
}

function createMockDb(selectResults: unknown[][], insertResult?: unknown, insertError?: Error) {
  const selectLimit = vi.fn(async () => selectResults.shift() ?? [])
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    limit: selectLimit,
  }

  const returning = vi.fn(async () => {
    if (insertError) {
      throw insertError
    }

    return [insertResult]
  })

  const insertChain = {
    values: vi.fn(() => insertChain),
    returning,
  }

  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
  } as any

  return { db, selectLimit, insertChain, returning }
}

describe('workspace service invitations', () => {
  it('returns an existing pending invitation instead of inserting a duplicate', async () => {
    const existingInvitation = makeInvitation()
    const { db, insertChain } = createMockDb([[existingInvitation]])
    const service = createWorkspaceService(db)

    const result = await service.createInvitation(
      existingInvitation.workspaceId,
      'Teammate@Example.com',
      'viewer',
      existingInvitation.invitedBy,
    )

    expect(result).toEqual(existingInvitation)
    expect(db.insert).not.toHaveBeenCalled()
    expect(insertChain.values).not.toHaveBeenCalled()
  })

  it('retries by loading the existing pending invite when insert races with a unique conflict', async () => {
    const existingInvitation = makeInvitation()
    const conflictError = Object.assign(new Error('duplicate key'), { code: '23505' })
    const { db } = createMockDb([[], [existingInvitation]], undefined, conflictError)
    const service = createWorkspaceService(db)

    const result = await service.createInvitation(
      existingInvitation.workspaceId,
      existingInvitation.emailLower,
      'viewer',
      existingInvitation.invitedBy,
    )

    expect(result).toEqual(existingInvitation)
    expect(db.insert).toHaveBeenCalledTimes(1)
  })

  it('allows resending after a previous invite was declined', async () => {
    const resentInvitation = makeInvitation({ id: 'invite-2', token: 'new-token' })
    // A declined invite should not be returned by the pending-only lookup, so resend starts from an empty result.
    const { db } = createMockDb([[]], resentInvitation)
    const service = createWorkspaceService(db)

    const result = await service.createInvitation(
      resentInvitation.workspaceId,
      resentInvitation.email,
      'viewer',
      resentInvitation.invitedBy,
    )

    expect(result).toEqual(resentInvitation)
    expect(db.insert).toHaveBeenCalledTimes(1)
  })
})
