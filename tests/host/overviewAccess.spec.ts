import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type { BackfillSessionStatus } from '../../src/host/backfill'
import type { PrincipalAccessFace } from '../../src/host/connection'
import { materializedSessionOf } from '../../src/host/overviewCorpus'
import { boot, call, dayOf, pageOf, recordOf, revisionOf, summaryOf, timelineOf } from './helpers/overview'
import { deferred } from './helpers/ctx'

const principal = { source: 'fixture', id: '1', username: 'account', role: 'user' } as const
const pageRequest = { part: 'page', scope: { range: 'all' } } as const
const forbidden = { ok: false, error: { code: 'gateway/forbidden', message: 'overview access changed during read' } }
const unavailable = { ok: false, error: { code: 'dsh-context/access-unavailable', message: 'account access unavailable' } }

function valuesOf(title: string) {
  return {
    title,
    contextTimeline: timelineOf(),
    contextActivity: { days: { '2026-11-01': dayOf(3, 1) } },
  }
}

async function coldFixture(backfillStatus?: (id: string) => BackfillSessionStatus | undefined) {
  const harness = await boot({
    scanTtlMs: 60_000,
    records: [recordOf('owned'), recordOf('foreign')],
    ...(backfillStatus === undefined ? {} : { backfillStatus }),
  })
  const identity = { path: '/fixture/owned.jsonl', sizeBytes: 100, mtimeMs: 1 }
  harness.state.cachedSessions.set('owned', materializedSessionOf(
    'owned', { id: 'owned', cwd: '/repo/owned', createdAt: 1 }, 'cache', { asOfSeq: 1, values: valuesOf('Owned') },
  ))
  harness.state.cachedIdentities.set('owned', identity)
  return { harness, identity }
}

test('a held account revision revalidates grants and cold identities without reloading rows', async ({ onTestFinished }) => {
  const { harness, identity } = await coldFixture()
  onTestFinished(harness.dispose)
  const provider = {
    resolve: vi.fn<NonNullable<PrincipalAccessFace['resolve']>>(async () => ({ readableSessionIds: new Set(['owned']) })),
  } satisfies PrincipalAccessFace
  harness.ctx.provide('principalAccess', provider)
  const load = vi.spyOn(harness.cache, 'load')
  const refresh = vi.spyOn(harness.cache, 'refresh')
  const first = await call(harness, pageRequest, principal)
  assert.equal(pageOf(first).items[0].title, 'Owned')
  assert.deepEqual(load.mock.calls, [[new Set(['owned'])]])
  const revision = revisionOf(first)
  const callsBeforePoll = provider.resolve.mock.calls.length
  assert.deepEqual((await call(harness, { ...pageRequest, revision }, principal)).reply.value, { revision, unchanged: true })
  assert.deepEqual(provider.resolve.mock.calls.slice(callsBeforePoll).map(([, subjects]) => subjects), [
    { sessionIds: ['foreign', 'owned'], workspaceIds: [] },
    { sessionIds: ['owned'], workspaceIds: [] },
  ])
  assert.equal(load.mock.calls.length, 1)
  assert.deepEqual(refresh.mock.calls, [[new Set(['owned']), new Map([['owned', identity]])]])
  assert.deepEqual(harness.calls.cached, [])

  const other = await call(harness, { ...pageRequest, revision }, { ...principal, source: 'another-provider' })
  assert.equal(pageOf(other).items[0].id, 'owned')
  assert.notEqual(revisionOf(other), revision)

  harness.state.refreshChanged = ['owned']
  harness.state.cachedIdentities.set('owned', { ...identity, sizeBytes: 101 })
  harness.state.cachedSessions.set('owned', materializedSessionOf(
    'owned', { id: 'owned', cwd: '/repo/owned', createdAt: 1 }, 'new-cache', { asOfSeq: 2, values: valuesOf('New') },
  ))
  const changed = await call(harness, { ...pageRequest, revision: revisionOf(other) }, { ...principal, source: 'another-provider' })
  assert.equal(pageOf(changed).items[0].title, 'New')
  assert.notEqual(revisionOf(changed), revisionOf(other))
  assert.deepEqual(load.mock.calls, Array.from({ length: 3 }, () => [new Set(['owned'])]))
})

test('a cold load loses authorization before projections are read', async ({ onTestFinished }) => {
  const harness = await boot({ records: [recordOf('owned'), recordOf('foreign')], values: { owned: valuesOf('Owned') } })
  const started = deferred()
  const resume = deferred()
  onTestFinished(() => { resume.resolve(); return harness.dispose() })
  let readableSessionIds = new Set(['owned'])
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds }),
  } satisfies PrincipalAccessFace)
  const load = harness.cache.load
  vi.spyOn(harness.cache, 'load').mockImplementationOnce(async (ids) => {
    assert.deepEqual(ids, new Set(['owned']))
    started.resolve()
    await resume.promise
    return load(ids)
  })
  const pending = call(harness, pageRequest, principal)
  await started.promise
  readableSessionIds = new Set()
  resume.resolve()
  const denied = await pending
  assert.equal(denied.status, 403)
  assert.deepEqual(denied.reply, forbidden)
  assert.deepEqual(harness.calls.cached, [])
  assert.deepEqual(pageOf(await call(harness, pageRequest, principal)).items, [])
})

test('a workspace grant lost during row materialization discards the response and revision', async ({ onTestFinished }) => {
  const started = deferred()
  const resume = deferred()
  const harness = await boot({
    records: [recordOf('owned', { live: true })],
    liveSeq: { owned: 2 },
    liveValues: { owned: valuesOf('Owned') },
    workspace: { list: () => [null, { id: 'visible', title: 'Project', sessionIds: ['owned'] }] },
    yieldEvery: 1,
    yieldTo: () => { started.resolve(); return resume.promise },
  })
  onTestFinished(() => { resume.resolve(); return harness.dispose() })
  let readableWorkspaceIds = new Set(['visible'])
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: new Set(['owned']), readableWorkspaceIds }),
  } satisfies PrincipalAccessFace)
  const pending = call(harness, pageRequest, principal)
  await started.promise
  readableWorkspaceIds = new Set()
  resume.resolve()
  assert.deepEqual((await pending).reply, forbidden)
  assert.deepEqual(pageOf(await call(harness, pageRequest, principal)).groups, [{ key: '__ungrouped__', count: 1 }])
})

test('a grant lost during a conditional cold read prevents reuse of the old revision', async ({ onTestFinished }) => {
  const { harness } = await coldFixture()
  onTestFinished(harness.dispose)
  let readableSessionIds = new Set(['owned'])
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds }),
  } satisfies PrincipalAccessFace)
  const revision = revisionOf(await call(harness, pageRequest, principal))
  const refresh = harness.cache.refresh
  vi.spyOn(harness.cache, 'refresh').mockImplementationOnce(async (ids, known) => {
    const result = await refresh(ids, known)
    readableSessionIds = new Set()
    return result
  })
  assert.deepEqual((await call(harness, { ...pageRequest, revision }, principal)).reply, forbidden)
  assert.equal(harness.cache.loadCalls, 1)
})

test('a provider outage returns an unavailable Overview even when the client holds a valid revision', async ({ onTestFinished }) => {
  const { harness } = await coldFixture()
  onTestFinished(harness.dispose)
  let available = true
  const provider = {
    resolve: async () => {
      if (!available) throw new Error('private provider cause')
      return { readableSessionIds: new Set(['owned']) }
    },
  } satisfies PrincipalAccessFace
  harness.ctx.provide('principalAccess', provider)
  const first = await call(harness, pageRequest, principal)
  const revision = revisionOf(first)
  available = false
  const next = await call(harness, { ...pageRequest, revision }, principal)
  assert.equal(next.status, 503)
  assert.deepEqual(next.reply, unavailable)
  assert.equal(harness.cache.loadCalls, 1)
  assert.equal(harness.cache.refreshCalls, 0)
  available = true
  assert.deepEqual((await call(harness, { ...pageRequest, revision }, principal)).reply.value, { revision, unchanged: true })
})

test('an outage during cold identity refresh discards a held account revision', async ({ onTestFinished }) => {
  const { harness } = await coldFixture()
  onTestFinished(harness.dispose)
  const resolve = vi.fn<NonNullable<PrincipalAccessFace['resolve']>>(async () => ({ readableSessionIds: new Set(['owned']) }))
  harness.ctx.provide('principalAccess', { resolve } satisfies PrincipalAccessFace)
  const revision = revisionOf(await call(harness, pageRequest, principal))
  const refresh = harness.cache.refresh
  vi.spyOn(harness.cache, 'refresh').mockImplementationOnce(async (ids, known) => {
    const result = await refresh(ids, known)
    resolve.mockRejectedValueOnce(new Error('refresh lost the provider'))
    return result
  })
  const next = await call(harness, { ...pageRequest, revision }, principal)
  assert.equal(next.status, 503)
  assert.deepEqual(next.reply, unavailable)
  assert.equal(harness.cache.loadCalls, 1)
})

test('missing account services are unavailable while an explicit empty grant is valid', async ({ onTestFinished }) => {
  const { harness } = await coldFixture()
  onTestFinished(harness.dispose)
  assert.deepEqual((await call(harness, pageRequest, principal)).reply, unavailable)
  const removeProvider = harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: new Set<string>() }),
  } satisfies PrincipalAccessFace)
  const first = await call(harness, pageRequest, principal)
  assert.deepEqual(pageOf(first).items, [])
  removeProvider()
  assert.deepEqual((await call(harness, { ...pageRequest, revision: revisionOf(first) }, principal)).reply, unavailable)
  assert.equal(harness.cache.loadCalls, 0)
  assert.deepEqual(harness.calls.snapshot, [])
})

test('an unavailable session inventory fails and malformed rows never become authorization subjects', async ({ onTestFinished }) => {
  const { harness } = await coldFixture()
  onTestFinished(harness.dispose)
  const resolve = vi.fn<NonNullable<PrincipalAccessFace['resolve']>>(async () => ({ readableSessionIds: new Set(['owned']) }))
  harness.ctx.provide('principalAccess', { resolve } satisfies PrincipalAccessFace)
  harness.state.records = null
  const missing = await call(harness, pageRequest, principal)
  assert.equal(missing.status, 503)
  assert.equal(missing.reply.ok, false)
  assert.equal(resolve.mock.calls.length, 0)
  harness.state.records = [null, recordOf(''), recordOf('owned')]
  const restored = await call(harness, pageRequest, principal)
  assert.deepEqual(pageOf(restored).items.map(row => row.id), ['owned'])
  assert.deepEqual(resolve.mock.calls[0][1].sessionIds, ['owned'])
})

test.for([
  { range: '7d', days: 7 },
  { range: '30d', days: 30 },
])('a live revision is reusable up to the $range cutoff and expires at its TTL', async (rangeCase, { onTestFinished }) => {
  const cutoff = new Date(2026, 10, 8, 12, 34, 56, 789).getTime()
  const now = cutoff + rangeCase.days * 86_400_000
  vi.useFakeTimers({ toFake: ['Date'] })
  onTestFinished(() => { vi.useRealTimers() })
  vi.setSystemTime(now)
  const harness = await boot({
    scanTtlMs: 10,
    records: [recordOf('edge', { live: true, createdAt: cutoff })],
    liveSeq: { edge: 1 },
    liveValues: { edge: { ...valuesOf('Edge'), contextActivity: { days: {} } } },
  })
  onTestFinished(harness.dispose)
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: new Set(['edge']) }),
  } satisfies PrincipalAccessFace)
  const request = { ...pageRequest, scope: { range: rangeCase.range } }
  const first = await call(harness, request, principal)
  const revision = revisionOf(first)
  assert.deepEqual(pageOf(first).items.map(row => row.id), ['edge'])
  assert.deepEqual((await call(harness, { ...request, revision }, principal)).reply.value, { revision, unchanged: true })
  assert.deepEqual(harness.calls.snapshot, ['edge'])

  vi.setSystemTime(now + 1)
  const after = await call(harness, { ...request, revision }, principal)
  assert.deepEqual(pageOf(after).items, [])
  const afterRevision = revisionOf(after)
  assert.notEqual(afterRevision, revision)
  assert.equal(revisionOf(await call(harness, request, principal)), afterRevision)
  assert.deepEqual(harness.calls.snapshot, ['edge', 'edge', 'edge'])

  vi.setSystemTime(now + 10)
  const expired = await call(harness, { ...request, revision: afterRevision }, principal)
  assert.deepEqual(expired.reply.value, { revision: afterRevision, unchanged: true })
  assert.deepEqual(harness.calls.snapshot, ['edge', 'edge', 'edge', 'edge'])
})

test('a cold cache refresh and load outage falls back to the granted projection', async ({ onTestFinished }) => {
  const { harness } = await coldFixture()
  onTestFinished(harness.dispose)
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: new Set(['owned']) }),
  } satisfies PrincipalAccessFace)
  const request = { part: 'summary', scope: { range: 'all' } }
  const first = await call(harness, request, principal)
  assert.equal(summaryOf(first).tokens, 3)
  harness.cacheMode.values.owned = {
    ...valuesOf('Fallback'),
    contextActivity: { days: { '2026-11-01': dayOf(7, 1) } },
  }
  vi.spyOn(harness.cache, 'refresh').mockRejectedValueOnce(new Error('stat unavailable'))
  vi.spyOn(harness.cache, 'load').mockRejectedValueOnce(new Error('cache unavailable'))
  const next = await call(harness, { ...request, revision: revisionOf(first) }, principal)
  assert.equal(summaryOf(next).tokens, 7)
  assert.notEqual(revisionOf(next), revisionOf(first))
  assert.deepEqual(harness.calls.cached, ['owned'])
})

test('coverage counts each granted row once and excludes refused cached and projected rows', async ({ onTestFinished }) => {
  const statusOf = vi.fn((id: string): BackfillSessionStatus | undefined => {
    if (id === 'starting') return { running: true, refusal: undefined }
    if (id === 'failed') return { running: false, refusal: { kind: 'failed' } }
    if (id === 'unsupported') return { running: false, refusal: { kind: 'unsupported' } }
    if (id === 'unreadable' || id === 'foreign') {
      return { running: id === 'foreign', refusal: { kind: 'unreadable', reason: `${id} reason` } }
    }
  })
  const grants = ['ready', 'starting', 'failed', 'unsupported', 'unreadable']
  const child = { parentSession: 'ready', origin: 'subagent' } as const
  const refused = recordOf('unreadable', child)
  const harness = await boot({
    records: [...grants.filter(id => id !== 'unreadable').map(id => recordOf(id)), refused, recordOf('foreign')],
    values: { ready: valuesOf('Ready'), failed: valuesOf('Stale'), foreign: valuesOf('Foreign') },
    backfillStatus: statusOf,
  })
  onTestFinished(harness.dispose)
  harness.state.diskRebuild = ['unsupported']
  harness.state.cachedSessions.set('unreadable', materializedSessionOf(
    'unreadable', { id: 'unreadable', createdAt: 1, ...child }, 'cache',
    { asOfSeq: 1, values: valuesOf('Stale child') },
  ))
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: new Set(grants) }),
  } satisfies PrincipalAccessFace)
  const summary = summaryOf(await call(harness, { part: 'summary', scope: { range: 'all' } }, principal))
  assert.deepEqual(summary.coverage, {
    complete: false, remaining: 1, failed: 1, running: true, total: 5, covered: 1, unsupported: 1, unreadable: 1,
    unreadableSessions: [{ id: 'unreadable', reason: 'unreadable reason' }],
  })
  assert.equal(summary.tokens, 3)
  assert.deepEqual(new Set(statusOf.mock.calls.map(([id]) => id)), new Set(grants))
  assert.deepEqual(harness.calls.cached, ['failed', 'ready', 'starting'])
  const page = pageOf(await call(harness, pageRequest, principal))
  assert.deepEqual(page.items.map(row => row.id), ['ready', 'starting'])
})

test('account unreadable detail is capped after applying the grant and updates with its reasons', async ({ onTestFinished }) => {
  const ids = Array.from({ length: 17 }, (_, index) => `owned-${String(index).padStart(2, '0')}`)
  const foreign = Array.from({ length: 16 }, (_, index) => `foreign-${index}`)
  let reason = 'first refusal'
  let grants = new Set(ids)
  const harness = await boot({
    records: [...foreign, ...ids].map(id => recordOf(id)),
    coverage: {
      complete: true, remaining: 0, failed: 0, running: false, total: 33, covered: 0, unsupported: 0, unreadable: 33,
      unreadableSessions: foreign.map(id => ({ id, reason: 'foreign refusal' })),
    },
    backfillStatus: id => ({ running: false, refusal: { kind: 'unreadable', reason: id === ids[0] ? reason : id } }),
  })
  onTestFinished(harness.dispose)
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: grants }),
  } satisfies PrincipalAccessFace)
  const request = { part: 'summary', scope: { range: 'all' } }
  const first = await call(harness, request, principal)
  assert.deepEqual(summaryOf(first).coverage, {
    complete: true, remaining: 0, failed: 0, running: false, total: 17, covered: 0, unsupported: 0, unreadable: 17,
    unreadableSessions: ids.slice(0, 16).map(id => ({ id, reason: id === ids[0] ? 'first refusal' : id })),
  })
  reason = 'updated refusal'
  const changed = await call(harness, { ...request, revision: revisionOf(first) }, principal)
  assert.notEqual(revisionOf(changed), revisionOf(first))
  assert.deepEqual(summaryOf(changed).coverage.unreadableSessions?.[0], { id: ids[0], reason: 'updated refusal' })

  grants = new Set(ids.slice(1))
  const narrowed = await call(harness, { ...request, revision: revisionOf(changed) }, principal)
  assert.equal(summaryOf(narrowed).coverage.unreadable, 16)
  assert.deepEqual(summaryOf(narrowed).coverage.unreadableSessions, ids.slice(1).map(id => ({ id, reason: id })))
})

test('conditional account coverage changes when a cached row starts, is refused, and recovers', async ({ onTestFinished }) => {
  let status: BackfillSessionStatus | undefined
  const { harness } = await coldFixture(() => status)
  onTestFinished(harness.dispose)
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: new Set(['owned']) }),
  } satisfies PrincipalAccessFace)
  const request = { part: 'summary', scope: { range: 'all' } }
  const first = await call(harness, request, principal)
  status = { running: true, refusal: undefined }
  const working = await call(harness, { ...request, revision: revisionOf(first) }, principal)
  assert.equal(summaryOf(working).coverage.running, true)
  assert.equal(summaryOf(working).coverage.covered, 1)

  const refresh = harness.cache.refresh
  vi.spyOn(harness.cache, 'refresh').mockImplementationOnce(async (ids, known) => {
    const result = await refresh(ids, known)
    status = { running: false, refusal: { kind: 'unreadable', reason: 'known corrupt' } }
    return result
  })
  const refused = await call(harness, { ...request, revision: revisionOf(working) }, principal)
  assert.equal(summaryOf(refused).tokens, 0)
  assert.deepEqual(summaryOf(refused).coverage, {
    complete: true, remaining: 0, failed: 0, running: false, total: 1, covered: 0, unsupported: 0, unreadable: 1,
    unreadableSessions: [{ id: 'owned', reason: 'known corrupt' }],
  })
  status = undefined
  const recovered = await call(harness, { ...request, revision: revisionOf(refused) }, principal)
  assert.equal(summaryOf(recovered).tokens, 3)
  assert.equal(summaryOf(recovered).coverage.unreadable, 0)
})

test.for([true, false])('a refusal during row materialization is served only if the grant survives (%s)', async (keepGrant, { onTestFinished }) => {
  const started = deferred()
  const resume = deferred()
  const statuses = new Map<string, BackfillSessionStatus>()
  let grants = new Set(['root', 'child'])
  const harness = await boot({
    records: [recordOf('root'), recordOf('child', { parentSession: 'root', origin: 'subagent' })],
    values: { root: valuesOf('Root'), child: valuesOf('Child') },
    backfillStatus: id => statuses.get(id),
    yieldEvery: 1,
    yieldTo: () => { started.resolve(); return resume.promise },
  })
  onTestFinished(() => { resume.resolve(); return harness.dispose() })
  harness.ctx.provide('principalAccess', {
    resolve: async () => ({ readableSessionIds: grants }),
  } satisfies PrincipalAccessFace)
  const request = { part: 'summary', scope: { range: 'all' } }
  const pending = call(harness, request, principal)
  await started.promise
  statuses.set('child', { running: false, refusal: { kind: 'unreadable', reason: 'child refused' } })
  if (!keepGrant) grants = new Set(['root'])
  resume.resolve()
  const first = await pending
  if (keepGrant) {
    assert.equal(summaryOf(first).tokens, 3)
    assert.deepEqual(summaryOf(first).coverage.unreadableSessions, [{ id: 'child', reason: 'child refused' }])
  } else {
    assert.equal(first.status, 403)
    assert.deepEqual(first.reply, forbidden)
    const narrowed = summaryOf(await call(harness, request, principal))
    assert.equal(narrowed.coverage.unreadable, 0)
    assert.equal(narrowed.coverage.total, 1)
    assert.equal(narrowed.coverage.unreadableSessions, undefined)
  }
})
