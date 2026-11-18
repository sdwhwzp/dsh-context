import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SNAPSHOT_ROUTE, watchSnapshotRoute } from '../../src/host/snapshotRoute'
import type { OverviewCache } from '../../src/host/overviewCache'
import type { HostSession } from '../../src/host/overviewCorpus'
import { materializedCache } from './helpers/materialized'
import { connectionOf, deferred, fakeCtx, postJson } from './helpers/ctx'

interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

function sessionOf(): HostSession {
  return {
    id: 'cold-a', title: 'Cached', updatedAt: 1, blank: false, signature: '',
    timeline: null, activity: { days: {} },
    materialization: {
      asOfSeq: 9,
      facts: { id: 'cold-a', createdAt: 1 },
      signature: '',
      values: {
        contextTimeline: {
          ok: true,
          current: { system: 1, total: 2 },
          counts: { turns: 3, steps: 1 },
        },
        contextActivity: { days: { '2026-11-01': { tokens: 5, requests: 1 } } },
      },
    },
  }
}

function boot(cache: OverviewCache, cost?: unknown): Map<string, RouteBox> {
  const ctx = new Context()
  const routes = new Map<string, RouteBox>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch?: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
  })
  ctx.provide('sessionQuery', {
    listSessions: async () => [{ header: { id: 'cold-a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }],
  })
  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('sessionProjections', { snapshot: () => undefined })
  ctx.provide('sessionProjectionCache', { cachedSnapshot: () => { throw new Error('projection cache should not be read') } })
  watchSnapshotRoute(ctx, undefined, cache, cost as never)
  return routes
}

async function call(routes: Map<string, RouteBox>, revision?: string) {
  for (let index = 0; index < 300 && !routes.has(SNAPSHOT_ROUTE); index++) await new Promise(resolve => setTimeout(resolve, 1))
  const route = routes.get(SNAPSHOT_ROUTE)
  assert.ok(route?.fetch !== undefined)
  const response = await route.fetch(new Request(`http://dsh.test${SNAPSHOT_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['cold-a'], ...(revision === undefined ? {} : { revision }) }),
  }))
  return await response.json() as { value: Record<string, Record<string, unknown>>; revision?: string; unchanged?: boolean }
}

test('a materialized cold row serves its compact snapshot without the projection cache', async () => {
  const read = await call(boot(materializedCache(sessionOf())))
  const timeline = read.value['cold-a'].contextTimeline as Record<string, unknown>
  assert.deepEqual(timeline.current, { system: 1, total: 2 })
  assert.deepEqual(timeline.counts, { turns: 3, steps: 1 })
  assert.deepEqual(read.value['cold-a'].contextActivity, { days: { '2026-11-01': { tokens: 5, requests: 1 } } })
})

test('a stale materialized identity joins the revision and suppresses the projection fallback', async () => {
  const cache = materializedCache(sessionOf())
  cache.load = async () => ({
    sessions: new Map(),
    identities: new Map([['cold-a', { path: '/logs/cold-a', sizeBytes: 10, mtimeMs: 2 }]]),
    rebuild: new Set(['cold-a']),
  })
  const read = await call(boot(cache))
  assert.deepEqual(read.value, {})
  assert.equal(typeof read.revision, 'string')
})

test('a materialization without a timeline still serves its activity digest', async () => {
  const session = sessionOf()
  session.materialization!.values.contextTimeline = null
  const read = await call(boot(materializedCache(session)))
  assert.equal(read.value['cold-a'].contextTimeline, undefined)
  assert.ok(read.value['cold-a'].contextActivity !== undefined)
})

test('a price-book change invalidates a held materialized snapshot revision', async () => {
  let ready = false
  let version = 0
  const cost = {
    ready: () => ready,
    version: () => version,
    read: () => ({ usd: ready ? 1 : null, ready }),
    usd: () => (ready ? 1 : null),
    complete: () => ready,
  }
  const routes = boot(materializedCache(sessionOf()), cost)
  const first = await call(routes)
  ready = true
  version++
  const next = await call(routes, first.revision)
  assert.equal(next.unchanged, undefined)
  assert.ok(next.value['cold-a'] !== undefined)
  delete (cost as { version?: () => number }).version
  const withoutPriceVersion = await call(routes, next.revision)
  assert.equal(withoutPriceVersion.unchanged, undefined)
})

test('account snapshots omit a row revoked during a conditional materialization read', async ({ onTestFinished }) => {
  const cached = sessionOf()
  cached.materialization!.values.contextTimeline = {
    current: { total: 9 },
    billedGenerated: { reasoning: 7, answers: 1, calls: 1, unclassified: 0 },
  }
  const cache = materializedCache(cached)
  const loads: string[][] = []
  const load = cache.load
  const loading = deferred()
  const resume = deferred()
  cache.load = async ids => {
    loads.push([...ids])
    if (loads.length === 3) {
      loading.resolve()
      await resume.promise
    }
    return await load(ids)
  }
  const gets: string[] = []
  const grants = new Set(['cold-a', 'live-a'])
  const principal = { id: 'account' }
  const fake = fakeCtx({
    connection: connectionOf(),
    principalAccess: {
      resolve: async (caller: unknown) => {
        assert.equal(caller, principal)
        return { readableSessionIds: grants }
      },
    },
    sessionQuery: {
      listSessions: async () => ['cold-a', 'live-a', 'unavailable', 'another'].map(id => ({ header: { id, createdAt: 1, cwd: '/fixture' } })),
    },
    sessions: {
      get: (id: string) => {
        gets.push(id)
        if (id === 'unavailable') throw new Error('lookup failed')
        return id === 'live-a' ? { id } : undefined
      },
    },
    sessionProjections: { snapshot: () => ({ values: { contextTimeline: { current: { total: 3 } } } }) },
    sessionProjectionCache: { cachedSnapshot: () => assert.fail('no projection fallback expected') },
  })
  onTestFinished(fake.dispose)
  watchSnapshotRoute(fake.ctx, undefined, cache)
  const call = (body: unknown, caller?: unknown) => postJson(fake.captured, SNAPSHOT_ROUTE, body, caller)
  const first = await call({}, principal)
  assert.deepEqual(Object.keys(first.value as object), ['cold-a', 'live-a'])
  assert.deepEqual((first.value as Record<string, Record<string, unknown>>)['cold-a'].contextTimeline, {
    ok: true, current: { total: 9 }, billedGenerated: { reasoning: 7, answers: 1, calls: 1, unclassified: 0 },
  })
  assert.deepEqual(gets, ['cold-a', 'live-a'])
  const poll = await call({ revision: first.revision }, principal)
  assert.equal(poll.unchanged, true)
  const pending = call({ revision: first.revision }, principal)
  await Promise.race([loading.promise, pending])
  grants.delete('cold-a')
  resume.resolve()
  const after = await pending
  assert.deepEqual(Object.keys(after.value as object), ['live-a'])
  assert.notEqual(after.revision, first.revision)
  assert.equal(after.unchanged, undefined)
  assert.equal((await call({ revision: after.revision }, principal)).unchanged, true)
  grants.add('unavailable')
  assert.deepEqual(Object.keys((await call({}, principal)).value as object), ['live-a'])
  assert.deepEqual((await call({})).value, {})
  assert.deepEqual(loads, [['cold-a'], ['cold-a'], ['cold-a']])
  assert.equal(gets.includes('unavailable'), true)
  assert.equal(gets.includes('another'), false)
})
