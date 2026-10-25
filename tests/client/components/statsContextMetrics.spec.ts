import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { toolTallyOf } from '../../../src/client/components/statsContext'
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
