import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeStatsTiming } from '../../../src/client/components/statsTiming'
import type { TimingSpan, TimingTotals } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text, hover } from '../helpers/kit'

const kit = makeKit()
const StatsTiming = makeStatsTiming(kit, Donut)

/** Local HH:MM:SS exactly as the kit's fmtTime renders it (a timezone-free assertion). */
const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

const TIMING: TimingTotals = {
  wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, calls: 10, toolsMs: 300_000, toolCalls: 25,
  tools: { bash: { calls: 15, ms: 200_000 }, read: { calls: 8, ms: 80_000 } },
}

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string; dim: boolean } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
    dim: row.className.includes('lc-sl-row-dim'),
  }
}

describe('StatsTiming', () => {
  test('absent, all-zero, or zero-with-live-call timings render the empty state', async () => {
    for (const timing of [
      null,
      { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} },
      { wallMs: 0, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
    ] as const) {
      const m = await mount(h(StatsTiming, { timing }))
      assert.ok(text(m.container).includes('No timing data yet'))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 0)
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      await m.unmount()
    }
  })

  test('the donut center shows the wall total; rows lead with shares', async () => {
    const m = await mount(h(StatsTiming, { timing: TIMING }))
    assert.ok(text(m.container).includes('Timing Stats'))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10m0s')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Active Time')
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: 'LLM Gen', count: '2m20s', dim: false })
    // The tools row keeps the true 5m sum even though the ring clamps it.
    assert.deepEqual(rowOf(m.container, 2), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 4)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    await m.unmount()

    const zh = await mount(h(makeStatsTiming(makeKit('zh'), Donut), { timing: TIMING }))
    assert.ok(text(zh.container).includes('耗时统计'))
    await zh.unmount()
  })

  test('parallel tool overlap: the count keeps the true sum, the share caps at 100%', async () => {
    const timing: TimingTotals = { wallMs: 100_000, ttftMs: 25_000, genMs: 35_000, calls: 2, toolsMs: 200_000, toolCalls: 9, tools: { bash: { calls: 9, ms: 200_000 } } }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 2), { pct: '100.0%', label: 'Tool runs', count: '3m20s · 9 runs', dim: false })
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 3)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    assert.deepEqual(rowOf(m.container, 3), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[2])
    assert.ok(rows[2].className.includes('lc-sl-row-on'))
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[2]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    await hover(rows[3])
    assert.ok(rows[3].className.includes('lc-sl-row-on'))
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    await m.unmount()
  })

  test('a hostile no-wall timing keeps the painted slices plus the residual slot', async () => {
    const timing: TimingTotals = { wallMs: 0, ttftMs: 5_000, genMs: 0, calls: 3, toolsMs: 0, toolCalls: 1, tools: { bash: { calls: 1, ms: 0 } } }
    const m = await mount(h(StatsTiming, { timing }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    // Only TTFT carries time; the zero slices are dropped whole (a dash has nothing to qualify, and
    // their borrowed call count would mislead). The residual row keeps its slot so the card never resizes.
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 2)
    assert.deepEqual(rowOf(m.container, 0), { pct: '—', label: 'TTFT', count: '5.0s · 3 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '—', label: 'Overhead', count: '—', dim: true })
    await m.unmount()
  })

  test('a zero slice is omitted, but the residual overhead row keeps its slot', async () => {
    // No reasoning output, no tool calls: rows that would borrow the session's call count are dropped.
    const timing: TimingTotals = {
      wallMs: 532, ttftMs: 480, genMs: 52, reasoningMs: 0, textMs: 52, toolArgMs: 0,
      calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
    }
    const m = await mount(h(StatsTiming, { timing }))
    const labels = queryAll(m.container, '.lc-sl-label').map(n => n.textContent)
    assert.deepEqual(labels, ['TTFT', 'Answers', 'Overhead'], 'zero buckets and zero tools are gone; overhead stays')
    assert.equal(queryAll(m.container, '.lc-donut-seg').length, 2)
    assert.deepEqual(rowOf(m.container, 2), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    await m.unmount()
  })
})

describe('StatsTiming — the generation split', () => {
  // genMs 140s splits into thinking 90s, answer 30s, tool args 20s.
  const SPLIT: TimingTotals = {
    wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, reasoningMs: 90_000, textMs: 30_000, toolArgMs: 20_000,
    calls: 10, toolsMs: 300_000, toolCalls: 25, tools: { bash: { calls: 15, ms: 200_000 } },
  }

  test('the model slice expands into thinking / answer / tool args', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 6)
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '15.0%', label: 'Reasoning', count: '1m30s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '5.0%', label: 'Answers', count: '30.0s', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '3.3%', label: 'Tool args', count: '20.0s', dim: false })
    assert.deepEqual(rowOf(m.container, 4), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 5), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 6)
    await m.unmount()
  })

  test('decode slices never borrow call counts; their own block tallies qualify them; absent tallies render duration alone', async () => {
    // One model call can emit several tool-call blocks and often no reasoning at all, so a borrowed
    // per-call count would be a false tally.
    const borrowed = await mount(h(StatsTiming, { timing: { ...SPLIT, calls: 236, toolCalls: 302 } }))
    const sub = (i: number): string => queryAll(borrowed.container, '.lc-sl-sub')[i]?.textContent ?? ''
    assert.equal(sub(0), '1m40s · 236 calls', 'TTFT keeps its per-call count')
    for (const i of [1, 2, 3]) {
      assert.ok(!sub(i).includes('236 calls'), `decode row ${i} must not borrow the call count: ${sub(i)}`)
      assert.ok(!sub(i).includes('302'), `decode row ${i} must not borrow the tool count: ${sub(i)}`)
    }
    assert.equal(sub(4), '5m0s · 302 runs', 'tools keep their own per-run count')
    await borrowed.unmount()

    const folded = await mount(h(StatsTiming, { timing: { ...SPLIT, reasoningBlocks: 14, textBlocks: 5, toolArgBlocks: 26 } }))
    assert.deepEqual(rowOf(folded.container, 1), { pct: '15.0%', label: 'Reasoning', count: '1m30s · 14 blocks', dim: false })
    assert.deepEqual(rowOf(folded.container, 2), { pct: '5.0%', label: 'Answers', count: '30.0s · 5 blocks', dim: false })
    assert.deepEqual(rowOf(folded.container, 3), { pct: '3.3%', label: 'Tool args', count: '20.0s · 26 blocks', dim: false })
    await folded.unmount()

    for (const counts of [{ reasoningBlocks: 0 }, {}]) {
      const m = await mount(h(StatsTiming, { timing: { ...SPLIT, ...counts } }))
      assert.equal(rowOf(m.container, 1).count, '1m30s', JSON.stringify(counts))
      await m.unmount()
    }
  })

  test('a hostile bucket total exceeding the generation window clamps the ring, rows stay true', async () => {
    // The buckets claim 500s inside a 140s window: the ring caps them, every row keeps its own figure.
    const timing: TimingTotals = { ...SPLIT, reasoningMs: 400_000, textMs: 100_000, toolArgMs: 0 }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 1), { pct: '66.7%', label: 'Reasoning', count: '6m40s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '16.7%', label: 'Answers', count: '1m40s', dim: false })
    assert.equal(rowOf(m.container, 3).label, 'Tool runs')
    await m.unmount()
  })
})

describe('StatsTiming — the throughput figure', () => {
  const paired: TimingTotals = { ...TIMING, speedTokens: 12_345, speedMs: 42_720 }

  test('the output-speed figure: paired renders tok/s (one decimal under 10), unpaired or hostile renders none', async () => {
    const m = await mount(h(StatsTiming, { timing: paired }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, 'TPS 289 tok/s', '12345 tokens over 42.72s')
    assert.ok(rate?.getAttribute('title')?.includes('Output speed (TPS)'))
    await m.unmount()

    const slow = await mount(h(StatsTiming, { timing: { ...TIMING, speedTokens: 26, speedMs: 10_000 } }))
    assert.equal(query(slow.container, '.lc-card-rate')?.textContent, 'TPS 2.6 tok/s')
    await slow.unmount()

    for (const timing of [
      TIMING,
      { ...TIMING, speedTokens: 500, speedMs: 0 },
      { ...TIMING, speedTokens: Number.NaN, speedMs: 1_000 },
      { ...TIMING, speedTokens: -5, speedMs: 1_000 },
    ] as TimingTotals[]) {
      const bare = await mount(h(StatsTiming, { timing }))
      assert.equal(queryAll(bare.container, '.lc-card-rate').length, 0, JSON.stringify(timing.speedTokens))
      await bare.unmount()
    }
  })
})

describe('StatsTiming — the session-time strip', () => {
  const SPLIT: TimingTotals = {
    wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, reasoningMs: 90_000, textMs: 30_000, toolArgMs: 20_000,
    calls: 10, toolsMs: 300_000, toolCalls: 25, tools: { bash: { calls: 15, ms: 200_000 } },
  }
  // A 50-second session window (epoch 1s → 51s) holding 40s of ACTIVE time: the decode slices, then
  // tools and overhead, with 5s idle gaps (21s → 26s and 41s → 46s) that take no track on the strip.
  const SPANS: TimingSpan[] = [
    { kind: 'ttft', start: 1_000, end: 6_000 },
    { kind: 'reasoning', start: 6_000, end: 16_000 },
    { kind: 'text', start: 16_000, end: 21_000 },
    { kind: 'tools', start: 26_000, end: 41_000 },
    { kind: 'other', start: 46_000, end: 51_000 },
  ]

  test('an absent or empty spans collection paints no strip (the aggregate overview card)', async () => {
    const collections: (TimingSpan[] | undefined)[] = [undefined, []]
    for (const spans of collections) {
      const m = await mount(h(StatsTiming, { timing: TIMING, spans }))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 4, 'the rows still render')
      assert.equal(queryAll(m.container, '.lc-tstrip').length, 0)
      await m.unmount()
    }
  })

  test('the strip/donut/legend hover link works in both directions: a band lights its arc and row, a row lights the spans without a tip', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT, spans: SPANS }))
    const segs = queryAll(m.container, '.lc-tstrip-seg')
    await hover(segs[3])
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, `Tool runs 15.0s · ${timeOf(26_000)}`)
    assert.ok(segs[3].className.includes('lc-tstrip-seg-on'))
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[4]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(queryAll(m.container, '.lc-sl-row')[4].className.includes('lc-sl-row-on'))
    await m.unmount()

    const mirror = await mount(h(StatsTiming, { timing: SPLIT, spans: SPANS }))
    const rows = queryAll(mirror.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(query(mirror.container, '.lc-tstrip-bar').className.includes('lc-tstrip-dim'))
    const on = queryAll(mirror.container, '.lc-tstrip-seg-on')
    assert.equal(on.length, 1)
    assert.equal(on[0], queryAll(mirror.container, '.lc-tstrip-seg')[1])
    assert.equal(query(mirror.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await mirror.unmount()
  })
})
