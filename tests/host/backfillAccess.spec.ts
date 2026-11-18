import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { watchActivityBackfill } from '../../src/host/backfill'
import type { PrincipalAccessFace } from '../../src/host/connection'
import { arm, coldFaces, connectionOf, FAST_PACING, fakeState, trigger, until, type RouteBox } from './helpers/backfill'
import { deferred } from './helpers/ctx'

describe('backfill trigger authorization', () => {
  const principal = { source: 'fixture', id: '1', username: 'account', role: 'user' } as const
  const resolve = async () => ({ readableSessionIds: new Set<string>() })
  const access = {
    resolve,
    assertAuthenticated(caller) { assert.equal(caller, principal) },
  } satisfies Required<PrincipalAccessFace>
  const scenarios: { name: string; provider?: PrincipalAccessFace; caller?: typeof principal; ok: boolean }[] = [
    { name: 'missing identity', provider: access, ok: false },
    { name: 'missing provider', caller: principal, ok: false },
    { name: 'missing account assertion', provider: { resolve }, caller: principal, ok: false },
    {
      name: 'account assertion refuses the caller',
      provider: { resolve, assertAuthenticated: () => { throw new Error('account disabled') } },
      caller: principal,
      ok: false,
    },
    { name: 'authorized caller', provider: access, caller: principal, ok: true },
  ]
  for (const scenario of scenarios) test(scenario.name, async ({ onTestFinished }) => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route = arm(ctx, state)
    ctx.provide('requestPrincipal', {})
    if (scenario.provider !== undefined) ctx.provide('principalAccess', scenario.provider)
    let starts = 0
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING, { onStart: () => { starts++ } })
    onTestFinished(handle)
    const result: unknown = await (await trigger(route, scenario.caller)).json()
    if (scenario.ok) {
      assert.deepEqual(result, { ok: true })
      assert.equal(starts, 1)
      await until(() => (handle.coverage().complete ? true : undefined), 'the authorized pass completed')
      assert.deepEqual(state.coldSnapshots, ['a'])
    } else {
      assert.deepEqual(result, { ok: false, error: { code: 'gateway/forbidden', message: 'session access denied' } })
      assert.equal(starts, 0)
      assert.deepEqual(state.coldReads, [], 'a refused trigger never launches the pass')
    }
  })

  test('account requests share the already queued or running pass', async ({ onTestFinished }) => {
    const ctx = new Context()
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('principalAccess', access)
    let starts = 0
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING, { onStart: () => { starts++ } })
    const pending = deferred()
    onTestFinished(() => {
      pending.resolve()
      handle()
    })
    for (let request = 0; request < 2; request++) {
      assert.deepEqual(await (await trigger(route, principal)).json(), { ok: true })
    }
    assert.equal(starts, 1)
    const state = fakeState([])
    coldFaces(ctx, state, { sessionQuery: { listSessions: async () => { await pending.promise; return state.listed } } })
    await until(() => (handle.coverage().running ? true : undefined), 'the deferred pass started')
    assert.deepEqual(await (await trigger(route, principal)).json(), { ok: true })
    assert.equal(starts, 1)
    pending.resolve()
    await until(() => (handle.coverage().complete ? true : undefined), 'the shared pass finished')
  })

  test('a replacement provider handles authorized triggers after the retired read drains', async ({ onTestFinished }) => {
    const ctx = new Context()
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('principalAccess', access)
    const listed = [{ header: { id: 'same', cwd: '/repo/same' } }]
    const retired = fakeState(listed)
    const replacement = fakeState(listed)
    const reading = deferred()
    const cancelled = deferred()
    const release = deferred()
    const closing = deferred()
    const releaseClose = deferred()
    let providerUnloaded = false
    let closes = 0
    let changes = 0
    let starts = 0
    onTestFinished(async () => {
      release.resolve()
      releaseClose.resolve()
      await ctx.fiber.dispose()
    })
    const oldProvider = await ctx.plugin({
      name: 'retiring-backfill-provider',
      apply(providerCtx) {
        providerCtx.effect(() => () => { providerUnloaded = true })
        coldFaces(providerCtx, retired, {
          sessionPersistence: {
            open: async (id: string, _access: 'read', { signal }: { signal: AbortSignal }) => ({
              header: { id, cwd: '/repo/same', createdAt: 1 },
              inheritedEventCount: 0,
              read: async () => {
                signal.addEventListener('abort', cancelled.resolve, { once: true })
                reading.resolve()
                await release.promise
                return { events: [] }
              },
              close: async () => {
                closing.resolve()
                await releaseClose.promise
                closes++
              },
            }),
          },
        })
      },
    })
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING, {
      onStart: () => { starts++ },
      onChange: () => { changes++ },
    })
    assert.deepEqual(await (await trigger(route, principal)).json(), { ok: true })
    await reading.promise
    assert.deepEqual(handle.statusOf?.('same'), { running: true, refusal: undefined })
    const unloading = oldProvider.dispose()
    await cancelled.promise
    release.resolve()
    await closing.promise
    assert.equal(providerUnloaded, false)
    assert.equal(handle.statusOf?.('same'), undefined)
    releaseClose.resolve()
    await unloading
    assert.equal(providerUnloaded, true)
    assert.equal(closes, 1)
    const retiredChanges = changes
    const retiredFolds = handle.foldedSince(0)

    await ctx.plugin({
      name: 'replacement-backfill-provider',
      apply(providerCtx) { coldFaces(providerCtx, replacement) },
    })
    assert.deepEqual(await (await trigger(route)).json(), {
      ok: false, error: { code: 'gateway/forbidden', message: 'session access denied' },
    })
    assert.equal(starts, 1)
    assert.deepEqual(await (await trigger(route, principal)).json(), { ok: true })
    await until(
      () => (replacement.coldSnapshots.length === 1 && handle.coverage().complete ? true : undefined),
      'the replacement provider completed the authorized pass',
    )

    assert.deepEqual(retired.coldSnapshots, [])
    assert.equal(retiredChanges, 0)
    assert.deepEqual(retiredFolds, { version: 0, ids: [], workerIds: [] })
    assert.deepEqual(replacement.coldReads, ['same'])
    assert.deepEqual(handle.foldedSince(0), { version: 1, ids: ['same'], workerIds: [] })
  })

  test('a replacement verifies the same inventory again after a complete pass', async ({ onTestFinished }) => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    ctx.provide('principalAccess', access)
    const listed = [{ header: { id: 'same', cwd: '/repo/same' } }]
    const warm = fakeState(listed)
    warm.served.add('same')
    const first = await ctx.plugin({
      name: 'warm-backfill-provider',
      apply(providerCtx) { coldFaces(providerCtx, warm) },
    })
    let starts = 0
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING, { onStart: () => { starts++ } })
    assert.deepEqual(await (await trigger(route, principal)).json(), { ok: true })
    await until(() => (handle.coverage().complete ? true : undefined), 'the first provider verified its warm row')
    assert.deepEqual(warm.coldReads, [])
    await first.dispose()
    assert.equal(handle.coverage().complete, false)

    const cold = fakeState(listed)
    await ctx.plugin({
      name: 'cold-backfill-provider',
      apply(providerCtx) { coldFaces(providerCtx, cold) },
    })
    assert.deepEqual(await (await trigger(route, principal)).json(), { ok: true })
    await until(() => (handle.coverage().complete ? true : undefined), 'the replacement verified its own row')
    assert.deepEqual(cold.coldSnapshots, ['same'])
    handle()
    handle.request()
    assert.equal(starts, 2)
  })
})
