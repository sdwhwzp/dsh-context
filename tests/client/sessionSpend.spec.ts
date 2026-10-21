import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { sessionSpendOf, spendTokensOf } from '../../src/client/services'
import type { ClientCtx } from '../../src/client/services'

describe('sessionSpendOf', () => {
  const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (name: string) => services[name] }) as unknown as ClientCtx
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
})
