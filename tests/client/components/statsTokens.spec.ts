import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeStatsTokens } from '../../../src/client/components/statsTokens'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, hover, unhover } from '../helpers/kit'

const kit = makeKit()
const StatsTokens = makeStatsTokens(kit, Donut)

const CURRENT: Snapshot['current'] = { system: 200, tools: 100, user: 300, inject: 100, skill: 0, assistant: 200, tool: 100, total: 1000 }
// Billed input 400 (300 uncached + 100 read) + output 50 = the chat line's 450.
const USAGE: TokenUsage = { uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('StatsTokens', () => {
  test('the donut center is the chat line total; rows split it by composition', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '450')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    // Estimated composition (sum 1000) scales to billed input 400; rows share the whole 450.
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 7)
    const expected = [
      { pct: '17.8%', label: 'System Prompt', count: '≈80' },
      { pct: '8.9%', label: 'Tool Schemas', count: '≈40' },
      { pct: '26.7%', label: 'User Messages', count: '≈120' },
      { pct: '8.9%', label: 'Injected Context', count: '≈40' },
      { pct: '17.8%', label: 'Assistant Messages', count: '≈80' },
      { pct: '8.9%', label: 'Tool Results', count: '≈40' },
      { pct: '11.1%', label: 'Output', count: '50 · incl. reasoning' },
    ]
    expected.forEach((row, i) => assert.deepEqual(rowOf(m.container, i), row))
    await m.unmount()

    const zh = await mount(h(makeStatsTokens(makeKit('zh'), Donut), { usage: USAGE, current: CURRENT, breakdown: null }))
    assert.equal(query(zh.container, '.lc-card-title-text').textContent, 'Token 统计')
    await zh.unmount()

    const sparse: Snapshot['current'] = { system: 100, tools: 0, user: 300, inject: 0, skill: 0, assistant: 0, tool: 0, total: 400 }
    const sparseMount = await mount(h(StatsTokens, { usage: USAGE, current: sparse, breakdown: null }))
    assert.equal(queryAll(sparseMount.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(sparseMount.container, 0), { pct: '22.2%', label: 'System Prompt', count: '≈100' })
    assert.deepEqual(rowOf(sparseMount.container, 1), { pct: '66.7%', label: 'User Messages', count: '≈300' })
    assert.deepEqual(rowOf(sparseMount.container, 2), { pct: '11.1%', label: 'Output', count: '50 · incl. reasoning' })
    await sparseMount.unmount()
  })

  test('a delivered breakdown drives the prompt-side split ratios', async () => {
    const current: Snapshot['current'] = { system: 0, tools: 0, user: 150, inject: 0, skill: 0, assistant: 150, tool: 0, total: 300 }
    const breakdown: ContextBreakdown = { systemTokens: 100, toolsTokens: 100, messageTokens: 200 }
    const usage: TokenUsage = { uncachedInputTokens: 800, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage, current, breakdown }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '840')
    // Ratios 1:1:1:1 over input 800 → 200 each; shares of the 840 total.
    assert.deepEqual(rowOf(m.container, 0), { pct: '23.8%', label: 'System Prompt', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.8%', label: 'Tool Schemas', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '23.8%', label: 'User Messages', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '23.8%', label: 'Assistant Messages', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 4), { pct: '4.8%', label: 'Output', count: '40 · incl. reasoning' })
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 5)
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[0]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(rows[0].className.includes('lc-sl-row-on'))
    await unhover(rows[0])
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await m.unmount()
  })

  test('null or zero usage degrades to the matching center and zero rows with dash shares', async () => {
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const [usage, center] of [[null, '—'], [zero, '0']] as [TokenUsage | null, string][]) {
      const m = await mount(h(StatsTokens, { usage, current: CURRENT, breakdown: null }))
      assert.equal(query(m.container, '.lc-donut-center b').textContent, center)
      assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 8)
      for (const row of queryAll(m.container, '.lc-sl-row')) {
        assert.equal(row.querySelector('.lc-sl-pct')?.textContent, '—')
      }
      const counts = queryAll(m.container, '.lc-sl-sub').map(n => n.textContent)
      assert.deepEqual(counts, ['≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '0 · incl. reasoning'])
      assert.ok(query(m.container, '.lc-donut-track'), 'an all-zero ring draws the neutral track')
      await m.unmount()
    }
  })
})

describe('StatsTokens — the cache-hit corner figure', () => {
  test('a billed session shows its cache-hit share; an unbilled or unreported session renders no figure', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, 'Cache Hit 25.00%', '100 reads over the 400 billed')
    assert.ok(rate?.getAttribute('title')?.includes('Cumulative cache-read share'))
    await m.unmount()

    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const usage of [null, zero] as (TokenUsage | null)[]) {
      const bare = await mount(h(StatsTokens, { usage, current: CURRENT, breakdown: null }))
      assert.equal(queryAll(bare.container, '.lc-card-rate').length, 0, JSON.stringify(usage))
      await bare.unmount()
    }
  })
})
