import assert from 'node:assert/strict'
import { test } from 'vitest'
import { outputParts } from '../../src/host/generatedOutput'
import { assistantMessage, header } from './helpers/events'
import { driveTimeline } from './helpers/projection'
import { billedParts } from '../../src/client/categories'

test('reported output scales heuristic content prices and preserves reported reasoning', () => {
  assert.deepEqual(outputParts(10, 50, 50, 0, null), { reasoning: 5, answers: 5, calls: 0, unclassified: 0 })
  assert.deepEqual(outputParts(10, 50, 50, 0, 2), { reasoning: 2, answers: 8, calls: 0, unclassified: 0 })
  assert.deepEqual(outputParts(10, 0, 0, 50, null), { reasoning: 0, answers: 0, calls: 10, unclassified: 0 })
  assert.deepEqual(outputParts(10, 0, 0, 0, null), { reasoning: 0, answers: 0, calls: 0, unclassified: 10 })
  assert.deepEqual(outputParts(10, 50, 0, 0, null), { reasoning: 10, answers: 0, calls: 0, unclassified: 0 })
  assert.deepEqual(outputParts(10, 50, 0, 0, 3), { reasoning: 3, answers: 0, calls: 0, unclassified: 7 })
  assert.deepEqual(outputParts(10, 0, 20, 10, 20), { reasoning: 10, answers: 0, calls: 0, unclassified: 0 })
  assert.deepEqual(outputParts(9007199254740676, 599839973263443, 0, 0, null), { reasoning: 9007199254740676, answers: 0, calls: 0, unclassified: 0 })
  for (let output = 0; output < 64; output++) {
    const parts = outputParts(output, 3, 5, 7, null)
    assert.equal(Object.values(parts).reduce((a, b) => a + b, 0), output)
    assert.ok(Object.values(parts).every(value => Number.isInteger(value) && value >= 0))
  }
})

test('folded output figures reach the billed chart without treating estimates as reported reasoning', () => {
  const first = assistantMessage(2, { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'reply' }], usage: { inputTokens: 0, outputTokens: 10 } })
  const { view } = driveTimeline([header(1), first])
  assert.deepEqual(view.billedGenerated, { reasoning: 5, answers: 5, calls: 0, unclassified: 0 })
  const chart = billedParts(view.current, null, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 }, { billed: view.billedGenerated })
  assert.equal(chart.find(part => part.key === 'thinking')?.value, 5)
  assert.equal(chart.find(part => part.key === 'answers')?.value, 5)
  const next = assistantMessage(3, { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'reply' }], usage: { inputTokens: 0, outputTokens: 10, reasoningTokens: 2 } })
  assert.deepEqual(driveTimeline([header(1), first, next]).view.billedGenerated, { reasoning: 7, answers: 13, calls: 0, unclassified: 0 })
  assert.equal(driveTimeline([header(1), first, { seq: 3, time: 3000, type: 'session/end-seed', data: { inherited: true } }]).view.billedGenerated, undefined)
})
