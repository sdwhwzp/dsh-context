/**
 * dsh-spend's money display, reproduced.
 *
 * The ledger states every cost in the deployment's server-side BASE currency
 * (`currency` on the wire, USD in the common configuration). That is not the
 * figure dsh-spend's dashboard prints: the browser holds its own DISPLAY
 * currency — CNY unless the operator switched it — and converts at the host's
 * USD-CNY quote before formatting. A consumer that prints the base amount
 * under the base symbol therefore disagrees with the dashboard sitting beside
 * it on the same screen.
 *
 * The preference lives in one `localStorage` key that dsh-spend owns and this
 * module only reads, so flipping the dashboard's currency switch moves the
 * Context card with it. Formatting matches dsh-spend's `formatCost` digit for
 * digit -- 0, then two decimals from 1 up, none from 100 up, four below 1.
 */

/** The currencies dsh-spend converts between; anything else passes through unconverted. */
export type SpendCurrency = string

/** dsh-spend's display-preference key. Owned there, read-only here. */
const CURRENCY_KEY = 'dsh-spend:currency'

/** The USD-CNY quote the host serves with a priced answer. */
export interface SpendRates {
  USD: number
  CNY: number
}

/**
 * The display currency dsh-spend's dashboard is showing: the operator's stored
 * choice, else its own CNY default. Storage can be absent or refuse the read
 * (private mode, a hostile stub), and the card must still price.
 * @returns the stored currency code, or 'CNY'.
 */
export function spendDisplayCurrency(): SpendCurrency {
  // The client also renders where the DOM lib promises a Storage that does
  // not exist (workers, prerender), so the seat is read as optional.
  const storage = (globalThis as { localStorage?: Storage }).localStorage
  if (storage === undefined) return 'CNY'
  try {
    const stored = storage.getItem(CURRENCY_KEY)
    return typeof stored === 'string' && stored !== '' ? stored : 'CNY'
  } catch {
    return 'CNY'
  }
}

/**
 * One amount converted from the currency it is priced in to the one being
 * displayed. Only USD-CNY is known — dsh-spend's own rule — so any other pair
 * passes through at face value rather than inventing a rate.
 * @param value - the amount, in `from`.
 * @param from - the currency the amount is priced in.
 * @param to - the currency to display it in.
 * @param rates - the host's quote; a non-positive or absent CNY leg falls back
 *   to dsh-spend's fixed 7.2.
 * @returns the amount in `to`.
 */
export function spendConvert(value: number, from: SpendCurrency, to: SpendCurrency, rates: SpendRates | null | undefined): number {
  if (from === to) return value
  const quote = rates?.CNY
  const rate = typeof quote === 'number' && Number.isFinite(quote) && quote > 0 ? quote : 7.2
  if (from === 'USD' && to === 'CNY') return value * rate
  if (from === 'CNY' && to === 'USD') return value / rate
  return value
}

/** The symbol dsh-spend prints for a currency: everything that is not CNY reads as dollars. */
export function spendSymbol(currency: SpendCurrency): string {
  return currency === 'CNY' ? '¥' : '$'
}

/**
 * One ledger amount as dsh-spend's dashboard prints it: converted into the
 * display currency, then formatted on its magnitude.
 * @param value - the amount, priced in `from`.
 * @param from - the currency the ledger priced it in.
 * @param to - the display currency.
 * @param rates - the host's USD-CNY quote.
 * @returns the formatted amount, symbol included.
 */
export function formatSpendCost(value: number, from: SpendCurrency, to: SpendCurrency, rates: SpendRates | null | undefined): string {
  const n = spendConvert(Number.isFinite(value) ? value : 0, from, to, rates)
  const symbol = spendSymbol(to)
  if (n === 0) return `${symbol}0`
  if (n >= 100) return symbol + n.toFixed(0)
  if (n >= 1) return symbol + n.toFixed(2)
  return symbol + n.toFixed(4)
}
