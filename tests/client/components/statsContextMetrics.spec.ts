import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { flowCurve, measureFlow, toolTallyOf } from '../../../src/client/components/statsContext'
import type { SurfaceNode } from '../../../src/shared/types'

describe('toolTallyOf (the live-surface per-tool tally)', () => {
  const node = (cat: SurfaceNode['cat'], tool?: string): SurfaceNode => ({ seq: 0, cat, tokens: 0, ...(tool !== undefined ? { tool } : {}) })

  test('folds the host predicate: tool results, plus skill nodes carrying a tool', () => {
    const tally = toolTallyOf([
      node('tool', 'read'), node('tool', 'read'), node('tool', 'bash'),
      node('skill', 'run_code'), // a skill node carrying a tool counts
      node('skill'), // a bare skill node does not
      node('user'), node('assistant'),
      node('tool'), // an unnamed result counts toward the head figure but rides no pill
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1], ['run_code', 1]])
  })

  test('sorts count-desc then name-asc, skipping hostile shapes', () => {
    const tally = toolTallyOf([
      node('tool', 'bash'), node('tool', 'read'), node('tool', 'read'),
      { seq: 0, cat: 'tool', tokens: 0, tool: 5 } as unknown as SurfaceNode,
      node('tool', ''),
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1]])
  })

  test('count ties break name-asc in either insertion order', () => {
    assert.deepEqual(toolTallyOf([node('tool', 'zed'), node('tool', 'apple')]), [['apple', 1], ['zed', 1]])
    assert.deepEqual(toolTallyOf([node('tool', 'apple'), node('tool', 'zed')]), [['apple', 1], ['zed', 1]])
  })
})

describe('measureFlow (the connector geometry)', () => {
  const boxes = {
    inputs: { x: 0, y: 0, w: 100, h: 40 },
    events: { x: 0, y: 60, w: 100, h: 80 },
    session: { x: 160, y: 30, w: 120, h: 80 },
    tools: { x: 340, y: 0, w: 100, h: 40 },
    cost: { x: 340, y: 60, w: 100, h: 80 },
  }

  test('horizontal mode flows left→right, fanning the session edge at ⅓ and ⅔, colored by element', () => {
    const links = measureFlow(boxes, true)
    assert.equal(links.length, 4)
    assert.equal(links[0].d, `M 100 20 C 130 20 130 ${30 + 80 * (1 / 3)} 160 ${30 + 80 * (1 / 3)}`)
    assert.equal(links[1].d, `M 100 100 C 130 100 130 ${30 + 80 * (2 / 3)} 160 ${30 + 80 * (2 / 3)}`)
    assert.equal(links[2].d, `M 280 ${30 + 80 * (1 / 3)} C 310 ${30 + 80 * (1 / 3)} 310 20 340 20`)
    assert.equal(links[3].d, `M 280 ${30 + 80 * (2 / 3)} C 310 ${30 + 80 * (2 / 3)} 310 100 340 100`)
    assert.deepEqual(links.map(l => l.color), [
      'var(--color-green-500)', 'var(--color-purple-500)', 'var(--color-teal-500)', 'var(--color-pink-500)',
    ])
  })

  test('vertical mode flows top→bottom with the same fan', () => {
    const links = measureFlow(boxes, false)
    assert.equal(links.length, 4)
    assert.equal(links[0].d, `M 50 40 C 50 58 ${160 + 120 * (1 / 3)} 12 ${160 + 120 * (1 / 3)} 30`)
    assert.equal(links[3].d, `M ${160 + 120 * (2 / 3)} 110 C ${160 + 120 * (2 / 3)} 135 390 35 390 60`)
  })

  test('flowCurve floors the control distance so near neighbors still bow', () => {
    assert.equal(
      flowCurve({ x: 0, y: 0, dx: 1, dy: 0 }, { x: 20, y: 0, dx: -1, dy: 0 }),
      'M 0 0 C 18 0 2 0 20 0',
    )
  })
})
