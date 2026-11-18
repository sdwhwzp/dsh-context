import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import { useSessionSpend } from '../../src/client/components/useSessionSpend'
import { sessionSpendOf, spendTokensOf, type ClientCtx } from '../../src/client/dshFaces'
import type { SessionCostUsage } from '../../src/shared/types'
import { asClientCtx, makeTestGeneration, TestClientCtx } from './helpers/harness'
import { flush, mount, text } from './helpers/kit'

const ctxWith = (services: Record<string, unknown>): ClientCtx => asClientCtx(new TestClientCtx({ services }))

describe('sessionSpendOf', () => {
  const conn = (answer: () => unknown): Record<string, unknown> => ({
    isLoopback: true,
    rpc: { call: (_channel: string, _endpoint: string) => Promise.resolve(answer()) },
  })

  test('reads the ledger figure and re-proves every field', async () => {
    const spend = await sessionSpendOf(ctxWith({ connection: conn(() => ({
      ok: true,
      value: {
        sessionId: 's1', cost: 1.5, calls: 4, currency: 'CNY',
        rates: { USD: 1, CNY: 7.13, source: 'live' }, sessions: 29,
        inputTokens: 300, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 60,
        byModel: [
          {
            model: 'deepseek-v4-flash', provider: 'deepseek-official', calls: 3, cost: 1,
            inputTokens: 200, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 60,
          },
          // A malformed row drops rather than poisoning the split.
          null,
          { model: 42, provider: undefined, calls: 'x', cost: 0.5, inputTokens: 'x', outputTokens: 10 },
        ],
      },
    })) }), 's1')
    assert.deepEqual(spend, {
      cost: 1.5,
      currency: 'CNY',
      rates: { USD: 1, CNY: 7.13 },
      sessions: 29,
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 60,
      byModel: [
        {
          model: 'deepseek-v4-flash', provider: 'deepseek-official', cost: 1,
          inputTokens: 200, outputTokens: 30, cacheReadTokens: 900, cacheWriteTokens: 60,
        },
        { model: null, provider: null, cost: 0.5, inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    })
    assert.equal(spendTokensOf(spend!), 1300)
  })

  test('an unpriced session reports a null cost rather than zero', async () => {
    const spend = await sessionSpendOf(ctxWith({ connection: conn(() => ({ ok: true, value: { cost: null, byModel: [] } })) }), 's1')
    // An answer with no quote reads as no quote; the money formatter then
    // falls back to dsh-spend's own fixed rate.
    assert.deepEqual(spend, { cost: null, currency: 'USD', rates: { USD: 1, CNY: 0 }, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: [] })
  })

  test('every absence, refusal and failure reads as no answer', async () => {
    // No connection service, so no RPC caller at all.
    assert.equal(await sessionSpendOf(ctxWith({}), 's1'), null)
    // No session to price.
    assert.equal(await sessionSpendOf(ctxWith({ connection: conn(() => ({ ok: true, value: {} })) }), ''), null)
    // The remote refused, answered a non-record, or is not installed.
    assert.equal(await sessionSpendOf(ctxWith({ connection: conn(() => ({ ok: false })) }), 's1'), null)
    assert.equal(await sessionSpendOf(ctxWith({ connection: conn(() => 'garbage') }), 's1'), null)
    assert.equal(await sessionSpendOf(ctxWith({ connection: conn(() => ({ ok: true, value: 'garbage' })) }), 's1'), null)
    // A throwing transport never rejects out of the helper.
    assert.equal(await sessionSpendOf(ctxWith({ connection: { isLoopback: true, rpc: { call: () => { throw new Error('down') } } } }), 's1'), null)
    // A non-array byModel still yields an empty split.
    const odd = await sessionSpendOf(ctxWith({ connection: conn(() => ({ ok: true, value: { cost: 2, byModel: 'nope', currency: 7 } })) }), 's1')
    assert.deepEqual(odd, { cost: 2, currency: 'USD', rates: { USD: 1, CNY: 0 }, sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, byModel: [] })
  })

  test('replacing the context cancels a pending ledger read for the same session', async () => {
    let release: (answer: unknown) => void = () => {}
    let signal: AbortSignal | undefined
    const old = ctxWith({ connection: { rpc: {
      call: (_channel: string, _endpoint: string, _payload: unknown, active?: AbortSignal) => {
        signal = active
        return new Promise(resolve => { release = resolve })
      },
    } } })
    const next = ctxWith({ connection: conn(() => ({ ok: true, value: { cost: 2 } })) })
    function Probe({ ctx }: { ctx: ClientCtx }) {
      return h('span', null, useSessionSpend(ctx, 'same-id', undefined)?.cost ?? '—')
    }
    const mounted = await mount(h(Probe, { ctx: old }))
    assert.equal(text(mounted.container), '—')
    await mounted.update(h(Probe, { ctx: next }))
    assert.equal(signal?.aborted, true)
    release({ ok: true, value: { cost: 999 } })
    await flush()
    assert.equal(text(mounted.container), '2')
    await mounted.unmount()
  })
})

function spendProbe(connection: Record<string, unknown> = {}) {
  const calls: { channel: string; endpoint: string; payload: unknown; signal: AbortSignal; resolve: (value: unknown) => void }[] = []
  const ctx = ctxWith({
    connection: {
      ...connection,
      rpc: {
        call: (channel: string, endpoint: string, payload: unknown, signal: AbortSignal) =>
          new Promise<unknown>((resolve) => { calls.push({ channel, endpoint, payload, signal, resolve }) }),
      },
    },
  })
  function Probe({ sessionId, cost }: { sessionId?: string; cost?: SessionCostUsage }) {
    return h('span', null, useSessionSpend(ctx, sessionId, cost)?.cost ?? '—')
  }
  const reply = (index: number, value: unknown) => act(async () => {
    assert.ok(calls[index])
    calls[index].resolve(value)
  })
  const quote = (index: number, cost: number | null) => reply(index, { ok: true, value: { cost } })
  return { Probe, calls, reply, quote }
}

describe('session spend scope', () => {
  test('clears the ledger on connection loss and refetches for the same session on the next account', async () => {
    const generation = makeTestGeneration(1)
    const { Probe, calls, quote } = spendProbe({ generation: generation.face })
    const sessionId = 'same-id'
    const m = await mount(h(Probe, { sessionId }))
    await quote(0, 1)
    assert.equal(text(m.container), '1')
    await m.update(h(Probe, { sessionId, cost: {} }))
    assert.equal(calls.length, 2)
    assert.equal(text(m.container), '1')

    const connect = (id: number | null) => act(async () => { generation.set(id) })
    await connect(null)
    assert.equal(text(m.container), '—')
    assert.equal(calls[1].signal.aborted, true)
    assert.equal(calls.length, 2)
    await connect(2)
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[2].payload, calls[0].payload)
    assert.equal(text(m.container), '—')
    await quote(2, 2)
    await quote(1, 999)
    assert.equal(text(m.container), '2')

    await connect(3)
    assert.equal(calls.length, 4)
    assert.equal(text(m.container), '—')
    await quote(3, 3)
    assert.equal(text(m.container), '3')
    await m.unmount()
    assert.equal(generation.subscribers, 0)
  })

  test('a session round trip hides the previous ledger and discards the canceled session reply', async () => {
    const { Probe, calls, quote } = spendProbe()
    const m = await mount(h(Probe, { sessionId: 'a' }))
    await quote(0, 10)
    await m.update(h(Probe, { sessionId: 'b' }))
    assert.equal(text(m.container), '—')
    await m.update(h(Probe, {}))
    assert.equal(calls.length, 2)
    assert.equal(calls[1].signal.aborted, true)
    await m.update(h(Probe, { sessionId: 'a' }))
    assert.equal(text(m.container), '—')
    assert.deepEqual(calls.map(call => call.payload), ['a', 'b', 'a'].map(sessionId => ({ args: { request: { sessionId } } })))
    await quote(2, 11)
    await quote(1, 99)
    assert.equal(text(m.container), '11')
  })

  test('an unpriced or denied ledger refresh clears the quote so the estimate can be shown', async () => {
    const { Probe, calls, reply, quote } = spendProbe()
    const sessionId = 's1'
    const m = await mount(h(Probe, { sessionId }))
    await quote(0, 1)
    assert.equal(text(m.container), '1')
    await m.update(h(Probe, { sessionId, cost: {} }))
    await quote(1, null)
    assert.equal(text(m.container), '—')
    await m.update(h(Probe, { sessionId, cost: {} }))
    await quote(2, 2)
    assert.equal(text(m.container), '2')
    await m.update(h(Probe, { sessionId, cost: {} }))
    await reply(3, { ok: false })
    assert.equal(text(m.container), '—')
    assert.equal(calls.length, 4)
  })

  test('a unary connection reads the ledger without subscribing to stream generations', async () => {
    const generation = makeTestGeneration(null)
    const { Probe, calls, quote } = spendProbe({ generation: generation.face, interactions: 'none' })
    const m = await mount(h(Probe, { sessionId: 'unary' }))
    assert.equal(generation.subscribers, 0)
    assert.equal(calls[0]?.channel, '/api')
    assert.equal(calls[0]?.endpoint, 'usageStats/sessionCost')
    await quote(0, 4)
    assert.equal(text(m.container), '4')
  })
})
