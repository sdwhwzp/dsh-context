import assert from 'node:assert/strict'
import { act } from 'react'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { invalidate, resetInvalidations } from '../../../src/client/invalidation'
import { makeTestGeneration, TestClientCtx } from '../helpers/harness'
import { hover, query, queryAll, text } from '../helpers/kit'
import {
  NOW, panelPageValue, panelRows, panelSummaryRaw as summaryRaw, panelTallies, pinCurrentSession, stubPanelRoutes as stubRoutes,
} from '../overview.fixtures'
import { makeCtx, openPanelFake, settingsWith } from './overviewPanelHarness'

beforeEach(() => {
  pinCurrentSession('a')
})

afterEach(async () => {
  resetInvalidations()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
  await new Promise(resolve => setTimeout(resolve, 1))
})

const progress = (covered: number, total: number): string => `Folding projections (${covered}/${total})…`

describe('OverviewPanel coverage state', () => {
  test('an incomplete coverage shows progress and re-reads overview without posting backfill', async () => {
    vi.useFakeTimers()
    const incomplete = { complete: false, running: false, remaining: 2, failed: 0, total: 3, covered: 1, unsupported: 0, unreadable: 0 }
    const calls = stubRoutes({
      summary: () => ({ revision: 's0', pricingReady: true, summary: summaryRaw({ coverage: incomplete }) }),
    })
    const { m } = await openPanelFake(makeCtx())
    assert.equal(calls.filter(c => c.route.endsWith('/overview')).length, 6, 'summary, days, page, and three tallies fetched once')
    assert.ok(text(m.container).includes(progress(1, 3)), 'the partial projection set is annotated')
    assert.equal(calls.filter(c => c.route.endsWith('/backfill')).length, 0)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(calls.filter(c => c.route.endsWith('/backfill')).length, 0, 'the host owns continuation')
    assert.ok(calls.filter(c => c.route.endsWith('/overview')).length > 6, 'coverage progress schedules fresh overview reads')
    await m.unmount()
  })

  test('running, failed, and starting coverage never post the backfill route', async () => {
    vi.useFakeTimers()
    const running = { complete: false, running: true, remaining: 2, failed: 0, total: 3, covered: 1, unsupported: 0, unreadable: 0 }
    const runningCalls = stubRoutes({
      summary: () => ({ revision: 's0', pricingReady: true, summary: summaryRaw({ coverage: running }) }),
    })
    const first = await openPanelFake(makeCtx())
    assert.ok(text(first.m.container).includes(progress(1, 3)))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(runningCalls.filter(c => c.route.endsWith('/backfill')).length, 0, 'a running pass is left alone')
    await first.m.unmount()

    const failed = { complete: false, running: false, remaining: 0, failed: 1, total: 3, covered: 2, unsupported: 0, unreadable: 0 }
    const failedCalls = stubRoutes({
      summary: () => ({ revision: 's1', pricingReady: true, summary: summaryRaw({ coverage: failed }) }),
    })
    const second = await openPanelFake(makeCtx())
    assert.ok(text(second.m.container).includes('1 sessions failed to fold'), 'a failed pass is marked, not silent')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(failedCalls.filter(c => c.route.endsWith('/backfill')).length, 0, 'a failed pass is not retried forever')
    await second.m.unmount()

    const startingCalls = stubRoutes({
      summary: () => ({
        revision: 's2',
        pricingReady: true,
        summary: summaryRaw({ coverage: { complete: false, running: false, remaining: 0, failed: 0, total: 0, covered: 0, unsupported: 0, unreadable: 0 } }),
      }),
    })
    const third = await openPanelFake(makeCtx())
    assert.ok(text(third.m.container).includes('Folding projections…'), 'an unlisted pass reads as starting')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.equal(startingCalls.filter(c => c.route.endsWith('/backfill')).length, 0, 'startup is host-owned even before the first corpus listing')
    await third.m.unmount()
  })

  test('a settled pass with unreadable sessions keeps their ids and reasons in the pill tooltip', async () => {
    vi.useFakeTimers()
    stubRoutes({
      summary: () => ({
        revision: 's0',
        pricingReady: true,
        summary: summaryRaw({
          coverage: {
            complete: true,
            remaining: 0,
            failed: 0,
            running: false,
            total: 3,
            covered: 2,
            unsupported: 0,
            unreadable: 1,
            unreadableSessions: [{ id: '31a305b6-session', reason: 'SessionPersistenceCorruptionError: stored log is corrupt' }],
          },
        }),
      }),
    })
    const { m } = await openPanelFake(makeCtx())
    assert.ok(text(m.container).includes('Unreadable sessions: 1'))
    const pill = m.container.querySelector('.lc-ov-folding')
    assert.ok(pill !== null, 'the unreadable pill is mounted')
    const title = pill.getAttribute('title') ?? ''
    assert.ok(title.includes('DeepSeek Harness refuses to read these session logs'))
    assert.ok(title.includes('31a305b6-session'))
    assert.ok(title.includes('stored log is corrupt'))
    await m.unmount()

    stubRoutes({
      summary: () => ({
        revision: 's1',
        pricingReady: true,
        summary: summaryRaw({
          coverage: {
            complete: false,
            remaining: 2,
            failed: 0,
            running: true,
            total: 3,
            covered: 1,
            unsupported: 0,
            unreadable: 1,
            unreadableSessions: [{ id: 'refused', reason: 'host refused the log' }],
          },
        }),
      }),
    })
    const running = await openPanelFake(makeCtx())
    assert.ok(text(running.m.container).includes(progress(1, 3)), 'a running pass still shows progress')
    const runningTitle = running.m.container.querySelector('.lc-ov-folding')?.getAttribute('title') ?? ''
    assert.ok(runningTitle.includes('refused'), 'the running tooltip carries the unreadable detail')
    await running.m.unmount()

    stubRoutes({
      summary: () => ({
        revision: 's2',
        pricingReady: true,
        summary: summaryRaw({
          coverage: {
            complete: true, remaining: 0, failed: 0, running: false, total: 3, covered: 2, unsupported: 0, unreadable: 1,
          },
        }),
      }),
    })
    const bare = await openPanelFake(makeCtx())
    assert.ok(text(bare.m.container).includes('Unreadable sessions: 1'))
    assert.equal(
      bare.m.container.querySelector('.lc-ov-folding')?.getAttribute('title'),
      'DeepSeek Harness refuses to read these session logs, so folding skips them for now; a Harness update retries them automatically',
    )
    await bare.m.unmount()
  })

  test('a progressing coverage repaints the label in place', async () => {
    vi.useFakeTimers()
    let covered = 1
    stubRoutes({
      summary: () => ({
        revision: `s${covered}`,
        pricingReady: true,
        summary: summaryRaw({
          coverage: { complete: false, running: true, remaining: 3 - covered, failed: 0, total: 3, covered, unsupported: 0, unreadable: 0 },
        }),
      }),
    })
    const { m } = await openPanelFake(makeCtx())
    assert.ok(text(m.container).includes(progress(1, 3)), 'the first progress tick renders')
    covered = 2
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    assert.ok(text(m.container).includes(progress(2, 3)), 'the label follows the host coverage')
    await m.unmount()
  })
})

test('changing account connection generations evicts overview data and revisions with the same selected session', async () => {
  vi.useFakeTimers()
  const generation = makeTestGeneration(1)
  const ctx = new TestClientCtx({ services: { connection: { generation: generation.face } } })
  const firstAccount = () => generation.face.getSnapshot()?.id === 1
  const connect = (id: number | null) => act(async () => { generation.set(id) })
  let releaseSummary: ((value: unknown) => void) | undefined
  let releaseSkills: ((value: unknown) => void) | undefined
  const summary = (tokens: number) => ({ revision: 'shared-revision', pricingReady: true, summary: summaryRaw({ tokens }) })
  const skill = (path: string) => ({ skills: [{ name: 'tdd', path }] })
  const calls = stubRoutes({
    tallies: { ...panelTallies(), skills: [{ name: 'tdd', n: 2, sessions: 1, last: NOW - 1000 }] },
    summary: body => {
      if (firstAccount() && body.revision === 'shared-revision') {
        return new Promise<unknown>(resolve => { releaseSummary = resolve })
      }
      return summary(firstAccount() ? 111 : 222)
    },
    page: body => panelPageValue(body, panelRows().slice(0, 1).map(row => ({
      ...row, title: firstAccount() ? 'first account session' : 'second account session',
    }))),
    skills: () => firstAccount()
      ? new Promise<unknown>(resolve => { releaseSkills = resolve })
      : skill('/second/tdd/SKILL.md'),
  })
  const { m } = await openPanelFake(ctx, {}, settingsWith('all'))
  const tokens = () => queryAll(m.container, '.lc-stat-value')[1]?.textContent
  const overviewCalls = () => calls.filter(call => call.route.endsWith('/overview'))
  const skillsCalls = () => calls.filter(call => call.route.endsWith('/skills'))
  assert.equal(tokens(), '111')
  assert.ok(text(m.container).includes('first account session'))
  assert.deepEqual(skillsCalls()[0].body, { sessionId: 'a', cwd: '/repo/alpha' })
  await act(async () => {
    invalidate('overview')
    await vi.advanceTimersByTimeAsync(250)
  })
  assert.ok(releaseSummary)
  assert.ok(releaseSkills)
  const refresh = overviewCalls().find(call => call.body.revision === 'shared-revision')
  assert.ok(refresh?.signal)
  const before = overviewCalls().length

  await connect(null)
  assert.equal(refresh.signal.aborted, true)
  assert.equal(skillsCalls()[0].signal?.aborted, true)
  assert.equal(tokens(), '—')
  assert.ok(!text(m.container).includes('first account session'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  assert.equal(overviewCalls().length, before)
  assert.equal(skillsCalls().length, 1)

  await connect(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  const fresh = overviewCalls().slice(before)
  assert.equal(fresh.length, 6)
  for (const call of fresh) {
    assert.equal(call.body.revision, null)
    assert.deepEqual(call.body.scope, call.body.part === 'days' ? { coverage: 'all' } : { range: 'all', coverage: 'all' })
  }
  assert.deepEqual(skillsCalls()[1].body, skillsCalls()[0].body)
  assert.equal(tokens(), '222')
  assert.ok(text(m.container).includes('second account session'))
  await hover(query(m.container, 'button.lc-ov-tally'))
  const tip = () => document.getElementById('lc-skilltip-bubble')?.textContent ?? ''
  assert.ok(tip().includes('/second/tdd/SKILL.md'))
  await act(async () => {
    releaseSummary?.(summary(999))
    releaseSkills?.(skill('/first/tdd/SKILL.md'))
  })
  assert.equal(tokens(), '222')
  assert.ok(tip().includes('/second/tdd/SKILL.md'))
  await m.unmount()
  assert.equal(generation.subscribers, 0)
})
