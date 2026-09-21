/** DeepSeek platform balances read under the current login; no browser balance cache. */

import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { asRecord } from './services'

// The balance route of host/balance.ts — re-declared here (the client bundle
// inlines every import, and the host module must never reach it). Same-origin
// POST under the harness's authenticated `/api` fence.
const BALANCE_ROUTE = '/api/dsh-context/balance'

/** One platform amount ('110.00', or an already-numeric producer variant), or null. */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Narrow the delivered payload to a render-safe value (the same boundary
 * rigor as `timelineOf`): each entry's currency and amounts re-proved, an
 * entry failing the shape drops whole, and a payload with no valid entry is
 * no balance — the caller renders nothing rather than half a figure.
 */
export function platformBalanceOf(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balances) ? data.balances : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // Bounded catch: a hostile entry may throw on property access — it drops
    // whole, and the entries that prove their shape keep serving.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const total = amountOf(entry.total)
      const granted = amountOf(entry.granted)
      const toppedUp = amountOf(entry.toppedUp)
      if (typeof currency !== 'string' || currency === ''
        || total === null || granted === null || toppedUp === null) continue
      balances.push({ currency, total, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.isAvailable === true, balances }
    : null
}

/**
 * The entry matching the display currency (zh → CNY, en → USD), falling back
 * to the account's first entry when the platform reports none in it — a
 * number in the account's own currency beats no number.
 */
export function balanceEntryOf(
  balance: PlatformBalance | null | undefined,
  currency: 'cny' | 'usd',
): PlatformBalanceEntry | null {
  if (balance === null || balance === undefined || balance.balances.length === 0) return null
  const want = currency === 'cny' ? 'CNY' : 'USD'
  return balance.balances.find(entry => entry.currency === want) ?? balance.balances[0]
}

/** Read a fresh authorized balance; cancellation or an unavailable route returns null. */
export async function fetchPlatformBalance(signal?: AbortSignal): Promise<PlatformBalance | null> {
  try {
    const response = await fetch(BALANCE_ROUTE, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true || r.value === null || r.value === undefined) return null
    return platformBalanceOf(r.value)
  } catch {
    return null
  }
}
