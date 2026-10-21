import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { currentSessionOf, rowsOfSnapshot } from '../../src/client/overview'

describe('currentSessionOf', () => {
  test('the list snapshot\'s explicit current field wins where the line still carries it', () => {
    const byId = { a: { retainedBy: { mainView: 1 } }, b: {} }
    assert.equal(currentSessionOf({ current: 'b' }, byId), 'b')
  })

  test('the row the main view retains is current', () => {
    const byId = {
      a: { retainedBy: { mainView: 0, sidebar: 2 } },
      b: { retainedBy: { mainView: 1 } },
      c: { retainedBy: { mainView: 3 } },
    }
    assert.equal(currentSessionOf({}, byId), 'b')
    assert.equal(currentSessionOf({ current: 7 }, byId), 'b', 'a non-string field falls through to the retention read')
  })

  test('current Harness retention selects the visible session', () => {
    assert.equal(currentSessionOf({}, { a: { retainInfo: { mainView: 1 } } }), 'a')
  })

  test('no retained row, missing or malformed counts, and hostile rows read as no current session', () => {
    assert.equal(currentSessionOf({}, {}), undefined)
    assert.equal(currentSessionOf({}, { a: {}, b: { retainedBy: null }, c: { retainedBy: { mainView: '1' } }, d: 4 }), undefined)
    const hostile: Record<string, unknown> = { y: { retainedBy: { mainView: 1 } } }
    Object.defineProperty(hostile, 'x', { enumerable: true, get() { throw new Error('boom') } })
    assert.equal(currentSessionOf({}, hostile), 'y', 'the throwing row is skipped, the retained row still found')
  })

  test('rowsOfSnapshot marks the retained row on a snapshot without the current field', () => {
    const rows = rowsOfSnapshot({
      ids: ['a', 'b'],
      byId: { a: { displayTitle: 'A' }, b: { displayTitle: 'B', retainedBy: { mainView: 1 } } },
      phase: 'ready',
    })
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(row => [row.id, row.current]), [['a', false], ['b', true]])
  })
})
