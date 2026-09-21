// Balance parsing, currency selection and fresh account-authorized reads.
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { balanceEntryOf, platformBalanceOf, fetchPlatformBalance } from '../../src/client/balance'

const WIRE_BALANCE = {
  isAvailable: true,
  balances: [
    { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
    { currency: 'USD', total: 1.5, granted: 0.5, toppedUp: 1 },
  ],
}

function stubRoute(body: unknown | undefined, mode: 'ok' | 'reject' | 'status' = 'ok'): { calls: () => number } {
  let n = 0
  vi.stubGlobal('fetch', async () => {
    n++
    if (mode === 'reject') throw new Error('down')
    if (mode === 'status') return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  })
  return { calls: () => n }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('platformBalanceOf', () => {
  test('a delivered wire balance parses whole', () => {
    assert.deepEqual(platformBalanceOf(WIRE_BALANCE), WIRE_BALANCE)
  })

  test('absent or non-record payloads are no balance', () => {
    assert.equal(platformBalanceOf(undefined), null)
    assert.equal(platformBalanceOf(null), null)
    assert.equal(platformBalanceOf('balance'), null)
    assert.equal(platformBalanceOf([]), null)
  })

  test('a payload with no valid entry is no balance', () => {
    assert.equal(platformBalanceOf({ isAvailable: true }), null)
    assert.equal(platformBalanceOf({ balances: 'CNY' }), null)
    assert.equal(platformBalanceOf({ balances: [null, 'CNY', [], {}] }), null)
    assert.equal(platformBalanceOf({
      balances: [{ currency: '', total: 1, granted: 0, toppedUp: 0 }],
    }), null)
    assert.equal(platformBalanceOf({
      balances: [{ currency: 'CNY', total: 'abc', granted: 0, toppedUp: 0 }],
    }), null)
    assert.equal(platformBalanceOf({
      balances: [{ currency: 'CNY', total: -1, granted: 0, toppedUp: 0 }],
    }), null)
  })

  test('entries failing the shape drop whole, valid siblings survive', () => {
    const balance = platformBalanceOf({
      isAvailable: false,
      balances: [
        null,
        { currency: 'EUR', total: 2, granted: 0 },
        { currency: 'EUR', total: 2, granted: 0, toppedUp: 2 },
      ],
    })
    assert.deepEqual(balance, {
      isAvailable: false,
      balances: [{ currency: 'EUR', total: 2, granted: 0, toppedUp: 2 }],
    })
  })

  test('a hostile entry throwing on property access drops without throwing', () => {
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    assert.equal(platformBalanceOf({ balances: [hostile] }), null)
    const mixed = platformBalanceOf({ balances: [hostile, WIRE_BALANCE.balances[0]] })
    assert.deepEqual(mixed?.balances, [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }])
  })
})

describe('balanceEntryOf', () => {
  test('absent or empty balances pick nothing', () => {
    assert.equal(balanceEntryOf(null, 'cny'), null)
    assert.equal(balanceEntryOf(undefined, 'usd'), null)
    assert.equal(balanceEntryOf({ isAvailable: true, balances: [] }, 'cny'), null)
  })

  test('the display currency wins; the account\'s first currency is the fallback', () => {
    assert.deepEqual(balanceEntryOf(WIRE_BALANCE, 'cny'), WIRE_BALANCE.balances[0])
    assert.deepEqual(balanceEntryOf(WIRE_BALANCE, 'usd'), WIRE_BALANCE.balances[1])
    const eurOnly = platformBalanceOf({ balances: [{ currency: 'EUR', total: 2, granted: 0, toppedUp: 2 }] })
    assert.deepEqual(balanceEntryOf(eurOnly, 'usd'), eurOnly?.balances[0] ?? null)
  })
})

describe('fetchPlatformBalance', () => {
  test('each open reads the current account instead of reusing an administrator response', async () => {
    const { calls } = stubRoute({ ok: true, value: WIRE_BALANCE })
    assert.deepEqual(await fetchPlatformBalance(), WIRE_BALANCE)
    assert.deepEqual(await fetchPlatformBalance(), WIRE_BALANCE)
    assert.equal(calls(), 2)
    stubRoute({ ok: true, value: null })
    assert.equal(await fetchPlatformBalance(), null)
  })

  test('absent and malformed answers resolve null without reusing a prior figure', async () => {
    for (const [label, body, mode] of [
      ['route absent', undefined, 'status'],
      ['transport down', undefined, 'reject'],
      ['denied', { ok: true, value: null }, 'ok'],
      ['missing value', { ok: true }, 'ok'],
      ['bad envelope', { ok: false }, 'ok'],
      ['non-record envelope', null, 'ok'],
      ['invalid value', { ok: true, value: 'nope' }, 'ok'],
    ] as [string, unknown, 'ok' | 'reject' | 'status'][]) {
      stubRoute(body, mode)
      assert.equal(await fetchPlatformBalance(), null, label)
    }
  })

  test('an earlier administrator request cannot supply a later account request', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => {
        await gate
        return { ok: true, json: async () => ({ ok: true, value: WIRE_BALANCE }) }
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, value: null }) })
    vi.stubGlobal('fetch', fetcher)
    const administrator = fetchPlatformBalance()
    try {
      assert.equal(await fetchPlatformBalance(), null)
      assert.equal(fetcher.mock.calls.length, 2)
    } finally {
      release()
      assert.deepEqual(await administrator, WIRE_BALANCE)
    }
  })

  test('the supplied abort signal reaches the route request', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      assert.equal(options.signal, controller.signal)
      return { ok: true, json: async () => ({ ok: true, value: null }) }
    })
    vi.stubGlobal('fetch', fetcher)
    assert.equal(await fetchPlatformBalance(controller.signal), null)
    assert.equal(fetcher.mock.calls.length, 1)
  })
})
