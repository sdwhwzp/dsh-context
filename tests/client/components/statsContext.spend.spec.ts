import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'vitest'
import { makeStatsContext } from '../../../src/client/components/statsContext'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { SessionCostUsage } from '../../../src/shared/types'
import { flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const StatsContext = makeStatsContext(kit, () => ({ usage: null, count: 0 }))
const StatsContextZh = makeStatsContext(makeKit('zh'), () => ({ usage: null, count: 0 }))
const NO_FILES = { reads: 0, writes: 0, searches: 0, images: 0 }
const COST: SessionCostUsage = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}

function teamOf(container: HTMLElement): string {
  return text(query(container, '.lc-ledger-team-head .lc-strip-pair'))
}

function costCellsOf(container: HTMLElement): string[] {
  return queryAll(container, '.lc-ledger-out-body2 .lc-strip-cell').map(el =>
    (el.querySelector('i')?.textContent ?? '') + (el.querySelector('.lc-strip-pair')?.textContent ?? ''),
  )
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve({
    deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  }))
})
afterEach(() => { resetModelPrices() })

describe('the ledger figure', () => {
  const counts = { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 }
  const usage = (input: number, output: number, read: number, write: number) => ({
    inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write,
  })
  const spend = {
    cost: 12.5,
    currency: 'CNY',
    rates: { USD: 1, CNY: 7.13 },
    sessions: 1,
    ...usage(300_000, 40_000, 900_000, 60_000),
    byModel: [
      { model: 'deepseek-v4-flash', provider: 'deepseek-official', cost: 10, ...usage(200_000, 30_000, 900_000, 60_000) },
      { model: 'GLM-5.3-Flash', provider: 'zai', cost: 2.5, ...usage(100_000, 10_000, 0, 0) },
    ],
  }

  test('dsh-spend wins over the local estimate and brings its own currency', async () => {
    const m = await mount(h(StatsContext, { counts, files: NO_FILES, tools: [], cost: COST, spend, locale: 'en' }))
    assert.equal(teamOf(m.container), '1.3M/¥12.50')
    assert.equal(queryAll(m.container, '.lc-ledger-team-head a').length, 0)
    const tip = text(query(m.container, '.lc-ledger-team-head .lc-stat-tip-prices'))
    assert.ok(tip.includes('deepseek-v4-flash'))
    assert.ok(tip.includes('GLM-5.3-Flash'), 'a provider the local table cannot price still appears')
    assert.ok(tip.includes('1.2M tokens'), tip)
    assert.ok(tip.includes('110.0k tokens'), tip)
    await m.unmount()
  })

  test('the ledger family total is not increased by the separate subagent estimate', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: COST, count: 1 }))
    const m = await mount(h(Stats, { counts, files: NO_FILES, tools: [], cost: COST, spend, locale: 'en' }))
    await flush()
    assert.equal(teamOf(m.container), '1.3M/¥12.50')
    assert.ok(costCellsOf(m.container).includes('Subagents × 1?1.0M/$0.30'))
    await m.unmount()
  })

  test('an absent or unpriced ledger falls back to the local estimate', async () => {
    for (const value of [null, undefined, { ...spend, cost: null }]) {
      const m = await mount(h(StatsContext, { counts, files: NO_FILES, tools: [], cost: COST, spend: value, locale: 'en' }))
      await flush()
      assert.equal(teamOf(m.container), '1.0M/$0.30')
      await m.unmount()
    }
  })

  test('the money reads as dsh-spend prints it: its display currency, at the host quote', async () => {
    // The deployment prices in USD and the dashboard shows CNY, so the card
    // must not print the base amount under the base symbol.
    const usd = {
      cost: 0.1992,
      currency: 'USD',
      rates: { USD: 1, CNY: 7.13 },
      sessions: 1,
      ...usage(104_600, 77_600, 7_500_000, 0),
      byModel: [{ model: 'deepseek-v4.1-flash-expires-on-0910', provider: 'deepseek-official', cost: 0.1992, ...usage(104_600, 77_600, 7_500_000, 0) }],
    }
    const m = await mount(h(StatsContextZh, { counts, files: NO_FILES, tools: [], cost: COST, spend: usd, locale: 'zh' }))
    const shown = teamOf(m.container)
    assert.equal(shown, '7.7M/¥1.42')
    const tip = text(query(m.container, '.lc-ledger-team-head .lc-stat-tip-prices'))
    assert.ok(tip.includes('¥1.42'), tip)
    assert.ok(!tip.includes('$0.1992'), 'the base-currency amount never reaches the split')
    assert.ok(tip.includes('7.7M tokens'), tip)
    await m.unmount()
  })

  test('a delegating session shows every model of its family and says how many sessions', async () => {
    // The task ran its OCR through workflow members, each billing into its own
    // session; the card must not report only what the parent called itself.
    const family = {
      cost: 1.1992,
      currency: 'USD',
      rates: { USD: 1, CNY: 7.13 },
      sessions: 29,
      ...usage(829_100, 683_900, 52_737_700, 0),
      byModel: [
        { model: 'deepseek-v4-flash-vision-exp', provider: 'deepseek-official', cost: 0.711, ...usage(580_000, 526_000, 37_430_000, 0) },
        { model: 'deepseek-v4.1-flash-expires-on-0910', provider: 'deepseek-official', cost: 0.376, ...usage(209_100, 155_100, 15_060_000, 0) },
        { model: 'glm-5v-turbo', provider: 'zai', cost: 0.1122, ...usage(40_000, 2_800, 247_700, 0) },
      ],
    }
    const m = await mount(h(StatsContextZh, { counts, files: NO_FILES, tools: [], cost: COST, spend: family, locale: 'zh' }))
    assert.equal(teamOf(m.container), '54.3M/¥8.55')
    const tip = text(query(m.container, '.lc-ledger-team-head .lc-stat-tip-prices'))
    for (const model of ['deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash-expires-on-0910', 'glm-5v-turbo']) {
      assert.ok(tip.includes(model), `${model} missing from ${tip}`)
    }
    assert.ok(tip.includes('38.5M tokens'), tip)
    // The card says the figure is a family total rather than this session's own.
    assert.ok(text(m.container).includes('29 个会话'), 'the folded session count is stated')
    await m.unmount()
  })

  test('a session that delegated nothing keeps the note off', async () => {
    const m = await mount(h(StatsContextZh, { counts, files: NO_FILES, tools: [], cost: COST, spend, locale: 'zh' }))
    assert.ok(!text(m.container).includes('会话族'), 'a single-session figure claims no family')
    await m.unmount()
  })

  test('a ledger row with no model name still renders', async () => {
    const m = await mount(h(StatsContextZh, {
      counts,
      files: NO_FILES,
      tools: [],
      cost: COST,
      spend: { cost: 1, currency: 'USD', rates: { USD: 1, CNY: 7.13 }, sessions: 1, ...usage(1, 0, 0, 0), byModel: [{ model: null, provider: null, cost: 1, ...usage(1, 0, 0, 0) }] },
      locale: 'zh',
    }))
    assert.ok(text(query(m.container, '.lc-ledger-team-head .lc-stat-tip-prices')).includes('—'))
    await m.unmount()
  })
})
