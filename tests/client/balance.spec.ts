// The client balance reader (src/client/balance.ts): the delivered payload's
// boundary proof (hostile entries drop, a payload with no valid entry is no
// balance), the display-currency pick with the account's first currency as
// fallback, and the fetch store's never-rejecting, TTL-and-in-flight-shared
// read of the plugin route.

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { balanceEntryOf, fetchPlatformBalance, platformBalanceOf, resetPlatformBalance } from '../../src/client/balance'

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

beforeEach(() => {
  resetPlatformBalance()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  resetPlatformBalance()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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
  test('one route read narrows to the balance; identical reads share the TTL', async () => {
    const { calls } = stubRoute({ ok: true, value: WIRE_BALANCE })
    assert.deepEqual(await fetchPlatformBalance(), WIRE_BALANCE)
    vi.setSystemTime(1_000_000 + 59_000)
    assert.deepEqual(await fetchPlatformBalance(), WIRE_BALANCE)
    assert.equal(calls(), 1, 'within the TTL the cached answer serves')
    vi.setSystemTime(1_000_000 + 61_000)
    await fetchPlatformBalance()
    assert.equal(calls(), 2, 'past the TTL the route is read again')
  })

  test('every absent answer resolves null without rejecting', async () => {
    for (const [label, body, mode] of [
      ['route absent (404)', undefined, 'status'],
      ['transport down', undefined, 'reject'],
      ['definitive absence', { ok: true, value: null }, 'ok'],
      ['bad envelope', { ok: false }, 'ok'],
      ['value not a record', { ok: true, value: 'nope' }, 'ok'],
    ] as [string, unknown, 'ok' | 'reject' | 'status'][]) {
      resetPlatformBalance()
      stubRoute(body, mode)
      assert.equal(await fetchPlatformBalance(), null, label)
    }
  })

  test('concurrent reads share the one in-flight route read', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      await gate
      return { ok: true, json: async () => ({ ok: true, value: WIRE_BALANCE }) }
    })
    const first = fetchPlatformBalance()
    const second = fetchPlatformBalance()
    await Promise.resolve()
    release()
    assert.deepEqual(await Promise.all([first, second]), [WIRE_BALANCE, WIRE_BALANCE])
    assert.equal(calls, 1)
  })
})
