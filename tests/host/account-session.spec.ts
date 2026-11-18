import assert from 'node:assert/strict'
import { describe, expect, test, vi } from 'vitest'
import { canReadAccountSession, isActiveAccount, type PrincipalAccessFace } from '../../src/host/connection'
import { resolveBounds } from '../../src/host/config'
import { DELTA_ROUTE, watchDeltaChannel } from '../../src/host/delta'
import { DetailShadow } from '../../src/host/detailShadow'
import { FACTS_ROUTE, watchFactsChannel } from '../../src/host/facts'
import { FLEET_ROUTE, watchFleetChannel } from '../../src/host/fleet'
import { HEADS_ROUTE, watchHeadsChannel } from '../../src/host/headsRoute'
import { SKILLS_ROUTE, watchSkillCatalog } from '../../src/host/skills'
import { SNAPSHOT_ROUTE, watchSnapshotRoute } from '../../src/host/snapshotRoute'
import { OPEN_GATE, connectionOf, deferred, fakeCtx, observing, postRequest } from './helpers/ctx'

describe('account session grants', () => {
  const signal = new AbortController().signal
  const principal = { id: '1' }
  const access = { resolve: async () => ({ readableSessionIds: new Set(['own']) }) }
  const ctx = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })

  test('permits single-user hosts without account services', async () => {
    expect(await canReadAccountSession(ctx({}), undefined, undefined, signal)).toBe(true)
  })

  test('requires the service, identity and session when account mode is present', async () => {
    for (const [services, caller, session] of [
      [{ requestPrincipal: {} }, undefined, 'own'],
      [{}, principal, 'own'],
      [{ principalAccess: access }, undefined, 'own'],
      [{ principalAccess: access }, principal, undefined],
    ] as const) {
      expect(await canReadAccountSession(ctx(services), caller, session, signal)).toBe(false)
    }
  })

  test('requires the exact session in the resolved grant', async () => {
    expect(await canReadAccountSession(ctx({ principalAccess: access }), principal, 'own', signal)).toBe(true)
    expect(await canReadAccountSession(ctx({ principalAccess: access }), principal, 'foreign', signal)).toBe(false)
  })

  test('cancellation during account verification denies the read and skips further verification', async () => {
    const controller = new AbortController()
    const principalAccess = {
      ...access,
      assertAuthenticated: vi.fn(async () => { controller.abort() }),
    } satisfies Required<PrincipalAccessFace>
    const services = ctx({ principalAccess })
    expect(await isActiveAccount(services, principal, controller.signal)).toBe(false)
    expect(await isActiveAccount(services, principal, controller.signal)).toBe(false)
    expect(principalAccess.assertAuthenticated).toHaveBeenCalledTimes(1)
  })
})

test('denied session routes skip reads and report a provider outage as unavailable', async ({ onTestFinished }) => {
  let denied = true
  const provider = {
    resolve: async () => {
      if (!denied) throw new Error('private provider cause')
      return { readableSessionIds: new Set<string>() }
    },
  } satisfies PrincipalAccessFace
  const observe = vi.fn(async () => undefined)
  const get = vi.fn(() => undefined)
  const cachedSnapshot = vi.fn(() => undefined)
  const list = vi.fn(async () => [])
  const fake = fakeCtx({
    connection: connectionOf(),
    principalAccess: provider,
    sessionQuery: { observeSession: observe, listSessions: async () => [{ header: { id: 'owned', cwd: '/fixture' } }] },
    sessions: { get },
    sessionProjections: { snapshot: () => undefined },
    sessionProjectionCache: { cachedSnapshot },
    skills: { list },
  })
  onTestFinished(fake.dispose)
  const bounds = resolveBounds({})
  const shadow = new DetailShadow(fake.ctx, bounds, OPEN_GATE, () => observe)
  watchDeltaChannel(fake.ctx, bounds, OPEN_GATE, { live: true, retain() {}, stateOf: () => undefined }, shadow)
  watchFactsChannel(fake.ctx, bounds, { coldReads: OPEN_GATE })
  watchHeadsChannel(fake.ctx, { coldReads: OPEN_GATE })
  watchSkillCatalog(fake.ctx, OPEN_GATE)
  watchSnapshotRoute(fake.ctx)
  const principal = { source: 'fixture', id: '1', username: 'account', role: 'user' }
  const forbidden = { ok: false, error: { code: 'gateway/forbidden', message: 'session access denied' } }
  const empty = { ok: true, value: {} }
  const unavailable = { ok: false, error: { code: 'dsh-context/access-unavailable', message: 'account access unavailable' } }
  for (const [path, body, expected] of [
    [DELTA_ROUTE, { sessionId: 'owned', seq: 2, baseSeq: 1 }, forbidden],
    [FACTS_ROUTE, { sessionId: 'owned' }, forbidden],
    [SKILLS_ROUTE, { sessionId: 'owned' }, forbidden],
    [HEADS_ROUTE, { ids: ['owned'] }, empty],
    [SNAPSHOT_ROUTE, { ids: ['owned'] }, empty],
  ] as const) {
    const route = fake.routes.get(path)
    assert.ok(route?.fetch)
    denied = true
    const deniedFetch = await route.fetch(postRequest(path, body), principal)
    assert.equal(deniedFetch.status, path === FACTS_ROUTE ? 403 : 200)
    const deniedResponse = await deniedFetch.json() as Record<string, unknown>
    if (path === SNAPSHOT_ROUTE) assert.deepEqual(deniedResponse.value, {})
    else assert.deepEqual(deniedResponse, expected)
    denied = false
    const outage = await route.fetch(postRequest(path, body), principal)
    assert.equal(outage.status, 503)
    assert.deepEqual(await outage.json(), unavailable)
  }
  expect(observe).not.toHaveBeenCalled()
  expect(get).not.toHaveBeenCalled()
  expect(cachedSnapshot).not.toHaveBeenCalled()
  expect(list).not.toHaveBeenCalled()
})

test('heads omit a row revoked during the header read', async ({ onTestFinished }) => {
  const loading = deferred()
  const resume = deferred()
  const readableSessionIds = new Set(['cold', 'live'])
  const fake = fakeCtx({
    connection: connectionOf(),
    principalAccess: { resolve: async () => ({ readableSessionIds }) },
    sessionQuery: {
      listSessions: async () => {
        loading.resolve()
        await resume.promise
        return [{ header: { id: 'cold' } }]
      },
    },
    sessions: { get: (id: string) => id === 'live' ? { id } : undefined },
    sessionProjections: { snapshot: () => ({ values: { contextTimeline: { model: 'live' } } }) },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: { contextTimeline: { model: 'cold' } } }) },
  })
  onTestFinished(fake.dispose)
  watchHeadsChannel(fake.ctx, { coldReads: OPEN_GATE })
  const pending = fake.captured.fetch!(postRequest(HEADS_ROUTE, { ids: ['cold', 'live'] }), { id: 'account' })
  await Promise.race([loading.promise, pending])
  readableSessionIds.delete('cold')
  resume.resolve()
  const response = await pending
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, value: { live: { head: { model: 'live' } } } })
})

for (const change of ['rows revoked', 'root revoked', 'provider unavailable'] as const) {
  test(`fleet batches recheck grants after observations when ${change}`, async ({ onTestFinished }) => {
    const loading = deferred()
    const resume = deferred()
    const ids = ['linked', 'child', 'keep']
    const readableSessionIds = new Set([...ids, 'root', 'peer'])
    let unavailable = false
    const linked = observing([{
      type: 'subagent/catalog', seq: 1, time: 1,
      data: { childId: 'peer', childCreatedAt: 1, mode: 'one-shot' },
    }])
    const plain = observing([])
    const fake = fakeCtx({
      connection: connectionOf(),
      principalAccess: {
        resolve: async () => {
          if (unavailable) throw new Error('private provider cause')
          return { readableSessionIds }
        },
      },
      sessionQuery: {
        observeSession: async (id: string) => {
          if (id === 'keep') {
            loading.resolve()
            await resume.promise
          }
          return id === 'linked' ? linked.observeSession(id) : plain.observeSession(id)
        },
      },
    })
    onTestFinished(fake.dispose)
    watchFleetChannel(fake.ctx, OPEN_GATE)
    const batch = change === 'rows revoked' ? { ids } : { ids, rootId: 'root' }
    const pending = fake.captured.fetch!(postRequest(FLEET_ROUTE, { batch }), { id: 'account' })
    await Promise.race([loading.promise, pending])
    if (change === 'rows revoked') {
      readableSessionIds.delete('child')
      readableSessionIds.delete('peer')
    } else if (change === 'root revoked') {
      readableSessionIds.delete('root')
    } else {
      unavailable = true
    }
    resume.resolve()
    const response = await pending
    assert.equal(linked.disposeCount(), 1)
    assert.equal(plain.disposeCount(), 2)
    assert.equal(response.status, change === 'provider unavailable' ? 503 : 200)
    const result = await response.json()
    if (change === 'rows revoked') {
      assert.deepEqual(result, {
        ok: true,
        value: { rows: { keep: { messages: [], truncated: false } }, missing: ['linked', 'child'], total: 3 },
      })
    } else if (change === 'root revoked') {
      assert.deepEqual(result, { ok: false, error: { code: 'gateway/forbidden', message: 'session access denied' } })
    } else {
      assert.deepEqual(result, { ok: false, error: { code: 'dsh-context/access-unavailable', message: 'account access unavailable' } })
    }
  })
}
