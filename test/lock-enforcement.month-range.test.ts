import { describe, expect, it } from 'vitest'
import { isMutationBlockedByLock, validateReconcileMonthRange } from '../src/mutations/lock-enforcement.js'
import type { LockContext } from '../src/mutations/lock-enforcement.js'
import { MutationType } from '../src/mutations/types.js'
import type { BoardElement, Operation } from '../src/mutations/types.js'

function metaColumn(id: string, monthRange: unknown = { startYear: 2026, startMonth: 0, endYear: 2026, endMonth: 1, cols: 1 }): BoardElement {
  return {
    id,
    kind: 'META_COLUMN',
    x: 0,
    y: 0,
    zIndex: 1,
    updatedAt: 1,
    monthRange,
  }
}

function plainMeta(id: string): BoardElement {
  return { id, kind: 'META_COLUMN', x: 0, y: 0, zIndex: 1, updatedAt: 1 }
}

function calendarColumn(id: string, metaContainerId: string): BoardElement {
  return {
    id,
    kind: 'COLUMN',
    x: 0,
    y: 0,
    zIndex: 1,
    updatedAt: 1,
    metaContainerId,
    metaContainerOrder: 0,
    metaGridCol: 0,
    metaGridRow: 0,
  }
}

function context(elements: Array<[string, BoardElement]>): LockContext {
  return { elementsById: new Map(elements) }
}

function updateElement(elementId: string, fields: Record<string, unknown>): Operation {
  return { type: MutationType.UPDATE_ELEMENT, elementId, fields }
}

function move(elementId: string): Operation {
  return { type: MutationType.MOVE_ELEMENTS, moves: [{ elementId, x: 5, y: 5 }] }
}

function createElement(data: BoardElement): Operation {
  return { type: MutationType.CREATE_ELEMENT, elementId: data.id, data }
}

function deleteElements(elementIds: string[]): Operation {
  return { type: MutationType.DELETE_ELEMENTS, elementIds }
}

function reconcile(metaId: string, upserts: BoardElement[], deletes: string[] = []): Operation {
  return { type: MutationType.RECONCILE_MONTH_RANGE, metaId, upserts, deletes }
}

describe('managed month-range lock enforcement', () => {
  it('blocks moving a month out of a managed meta', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['month', calendarColumn('month', 'meta')],
    ])
    expect(isMutationBlockedByLock(move('month'), ctx)).toBe(true)
  })

  it('blocks reordering a month inside a managed meta', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['month', calendarColumn('month', 'meta')],
    ])
    expect(isMutationBlockedByLock(updateElement('month', { metaContainerOrder: 1 }), ctx)).toBe(true)
  })

  it('blocks containing a foreign element into a managed meta', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['foreign', { id: 'foreign', kind: 'COLUMN', x: 0, y: 0, zIndex: 1, updatedAt: 1 }],
    ])
    expect(isMutationBlockedByLock(updateElement('foreign', { metaContainerId: 'meta', metaContainerOrder: 5 }), ctx)).toBe(true)
    expect(isMutationBlockedByLock(createElement(calendarColumn('new-month', 'meta')), ctx)).toBe(true)
  })

  it('blocks deleting a month while its managed meta remains', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['month', calendarColumn('month', 'meta')],
    ])
    expect(isMutationBlockedByLock(deleteElements(['month']), ctx)).toBe(true)
  })

  it('allows deleting the managed meta together with its months (cascade)', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['month', calendarColumn('month', 'meta')],
    ])
    expect(isMutationBlockedByLock(deleteElements(['meta', 'month']), ctx)).toBe(false)
  })

  it('allows structural changes in plain meta layouts', () => {
    const ctx = context([
      ['meta', plainMeta('meta')],
      ['grid', calendarColumn('grid', 'meta')],
    ])
    expect(isMutationBlockedByLock(updateElement('grid', { metaContainerOrder: 3 }), ctx)).toBe(false)
  })
})

describe('RECONCILE_MONTH_RANGE integrity validation', () => {
  it('accepts a self-consistent reconcile', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['jan', calendarColumn('jan', 'meta')],
      ['feb', calendarColumn('feb', 'meta')],
    ])
    const op = reconcile('meta', [metaColumn('meta'), calendarColumn('jan', 'meta')], ['feb'])
    expect(validateReconcileMonthRange(op, ctx)).toBeNull()
  })

  it('rejects when the meta does not exist', () => {
    const op = reconcile('meta', [metaColumn('meta')])
    expect(validateReconcileMonthRange(op, context([]))).toBe('reconcile meta not found')
  })

  it('rejects when the meta is not a managed month-range', () => {
    const ctx = context([['meta', plainMeta('meta')]])
    expect(validateReconcileMonthRange(reconcile('meta', [metaColumn('meta')]), ctx)).toBe(
      'reconcile meta is not a managed month-range',
    )
  })

  it('rejects empty upserts', () => {
    const ctx = context([['meta', metaColumn('meta')]])
    expect(validateReconcileMonthRange(reconcile('meta', []), ctx)).toBe(
      'reconcile upserts must not be empty',
    )
  })

  it('rejects upserts that omit the managed meta', () => {
    const ctx = context([['meta', metaColumn('meta')]])
    const op = reconcile('meta', [calendarColumn('month', 'meta')])
    expect(validateReconcileMonthRange(op, ctx)).toBe(
      'reconcile upserts must include exactly one managed meta',
    )
  })

  it('rejects an upsert that is not contained in the meta', () => {
    const ctx = context([['meta', metaColumn('meta')]])
    const op = reconcile('meta', [metaColumn('meta'), calendarColumn('foreign', 'other')])
    expect(validateReconcileMonthRange(op, ctx)).toBe('reconcile upsert not contained in meta')
  })

  it('rejects deleting the meta itself', () => {
    const ctx = context([['meta', metaColumn('meta')]])
    expect(validateReconcileMonthRange(reconcile('meta', [metaColumn('meta')], ['meta']), ctx)).toBe(
      'reconcile may not delete its meta',
    )
  })

  it('rejects deleting an element that is not contained in the meta', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['foreign', calendarColumn('foreign', 'other')],
    ])
    const op = reconcile('meta', [metaColumn('meta')], ['foreign'])
    expect(validateReconcileMonthRange(op, ctx)).toBe('reconcile delete not contained in meta')
  })

  it('rejects overlapping upserts and deletes', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['jan', calendarColumn('jan', 'meta')],
    ])
    const op = reconcile('meta', [metaColumn('meta'), calendarColumn('jan', 'meta')], ['jan'])
    expect(validateReconcileMonthRange(op, ctx)).toBe('reconcile upserts and deletes overlap')
  })

  it('rejects duplicate ids in deletes', () => {
    const ctx = context([
      ['meta', metaColumn('meta')],
      ['jan', calendarColumn('jan', 'meta')],
    ])
    const op = reconcile('meta', [metaColumn('meta')], ['jan', 'jan'])
    expect(validateReconcileMonthRange(op, ctx)).toBe('reconcile deletes contain duplicate ids')
  })
})
