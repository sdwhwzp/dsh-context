// dsh-spend's money display, reproduced (src/client/spendMoney.ts): the
// display-currency preference it owns, the USD-CNY conversion, and the digit
// rules its `formatCost` applies.

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { formatSpendCost, spendConvert, spendDisplayCurrency, spendSymbol } from '../../src/client/spendMoney'

const KEY = 'dsh-spend:currency'
const RATES = { USD: 1, CNY: 7.13 }

/** Install a storage face for one case; every test restores the real one. */
function withStorage(storage: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })
}
const real = globalThis.localStorage
afterEach(() => { withStorage(real) })

describe('spendDisplayCurrency', () => {
  test('CNY is the default dsh-spend itself falls back to', () => {
    withStorage({ getItem: () => null })
    assert.equal(spendDisplayCurrency(), 'CNY')
    withStorage({ getItem: () => '' })
    assert.equal(spendDisplayCurrency(), 'CNY')
  })

  test('the operator’s stored choice wins, read from dsh-spend’s own key', () => {
    const asked: string[] = []
    withStorage({ getItem: (key: string) => { asked.push(key); return 'USD' } })
    assert.equal(spendDisplayCurrency(), 'USD')
    assert.deepEqual(asked, [KEY])
  })

  test('absent or hostile storage still prices', () => {
    withStorage(undefined)
    assert.equal(spendDisplayCurrency(), 'CNY')
    withStorage({ getItem: () => { throw new Error('denied') } })
    assert.equal(spendDisplayCurrency(), 'CNY')
  })
})

describe('spendConvert', () => {
  test('the same currency passes through untouched', () => {
    assert.equal(spendConvert(0.1992, 'USD', 'USD', RATES), 0.1992)
  })

  test('USD-CNY converts both ways at the host quote', () => {
    assert.equal(spendConvert(2, 'USD', 'CNY', RATES), 14.26)
    assert.equal(spendConvert(14.26, 'CNY', 'USD', RATES), 2)
  })

  test('an absent, zero or malformed quote falls back to dsh-spend’s fixed 7.2', () => {
    for (const rates of [null, undefined, { USD: 1, CNY: 0 }, { USD: 1, CNY: NaN }]) {
      assert.equal(spendConvert(2, 'USD', 'CNY', rates), 14.4)
    }
  })

  test('a pair dsh-spend does not know passes through rather than inventing a rate', () => {
    assert.equal(spendConvert(2, 'EUR', 'CNY', RATES), 2)
  })
})

describe('formatSpendCost', () => {
  test('the digit rules match dsh-spend: 0, four decimals below 1, two from 1, none from 100', () => {
    assert.equal(formatSpendCost(0, 'USD', 'USD', RATES), '$0')
    assert.equal(formatSpendCost(0.1992, 'USD', 'USD', RATES), '$0.1992')
    assert.equal(formatSpendCost(1.42, 'USD', 'USD', RATES), '$1.42')
    assert.equal(formatSpendCost(250.4, 'USD', 'USD', RATES), '$250')
  })

  test('a base-currency amount prints as the dashboard prints it', () => {
    // The deployment prices in USD; the dashboard shows CNY by default.
    assert.equal(formatSpendCost(0.1992, 'USD', 'CNY', RATES), '¥1.42')
  })

  test('a non-finite amount reads as zero rather than NaN', () => {
    assert.equal(formatSpendCost(NaN, 'USD', 'CNY', RATES), '¥0')
  })
})

describe('spendSymbol', () => {
  test('only CNY is the yuan sign', () => {
    assert.equal(spendSymbol('CNY'), '¥')
    assert.equal(spendSymbol('USD'), '$')
    assert.equal(spendSymbol('EUR'), '$')
  })
})
