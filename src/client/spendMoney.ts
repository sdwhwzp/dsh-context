export type SpendCurrency = string

const CURRENCY_KEY = 'dsh-spend:currency'

export interface SpendRates {
  USD: number
  CNY: number
}

export function spendDisplayCurrency(): SpendCurrency {
  try {
    return globalThis.localStorage.getItem(CURRENCY_KEY) || 'CNY'
  } catch {
    return 'CNY'
  }
}

export function spendConvert(value: number, from: SpendCurrency, to: SpendCurrency, rates: SpendRates | null | undefined): number {
  if (from === to) return value
  const quote = rates?.CNY
  const rate = typeof quote === 'number' && Number.isFinite(quote) && quote > 0 ? quote : 7.2
  if (from === 'USD' && to === 'CNY') return value * rate
  if (from === 'CNY' && to === 'USD') return value / rate
  return value
}

export function spendSymbol(currency: SpendCurrency): string {
  return currency === 'CNY' ? '¥' : '$'
}

export function formatSpendCost(value: number, from: SpendCurrency, to: SpendCurrency, rates: SpendRates | null | undefined): string {
  const amount = spendConvert(Number.isFinite(value) ? value : 0, from, to, rates)
  const symbol = spendSymbol(to)
  if (amount === 0) return `${symbol}0`
  if (amount >= 100) return symbol + amount.toFixed(0)
  if (amount >= 1) return symbol + amount.toFixed(2)
  return symbol + amount.toFixed(4)
}

export function formatSpendTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return String(value)
}
