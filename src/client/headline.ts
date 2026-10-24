import type { ContextBreakdown, ContextPressure, ContextTimeline } from '../shared/types'
import { anchoredParts, officialParts, type PartsPart } from './categories'
import { reserveGeometry, type ContextReserve } from './reserve'

export interface Headline {
  tokens: number
  /** Both optional: absent when no window is known; a refused compaction target drops `reserve` alone (`reserve.ts`). */
  window?: number
  pct: number | null
  /** `value` is the provider-anchored bar width (the ring's fill); `raw` the heuristic count the legend shows. */
  parts: PartsPart[]
  reserve?: ContextReserve
}

/** The kernel's own composer-ring derivation (`ui-conversation`'s `contextOccupancy`) on a 0.1 grid; `window > 0`. */
export function occupancyPercent(tokens: number, window: number): number {
  return Math.min(100, Math.round(tokens / window * 1000) / 10)
}

export function headlineOf(
  data: ContextTimeline,
  pressure: ContextPressure | null = null,
  breakdown: ContextBreakdown | null = null,
): Headline {
  const current = data.current
  // Same formula the chat ring displays: the official projection carried forward by heuristic surface movement.
  const projected = pressure !== null && typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : undefined
  // The kernel's own fallback order: the bare provider sample; a real fold stamps both figures together.
  const sampled = pressure !== null && typeof pressure.pressureTokens === 'number'
    ? pressure.pressureTokens
    : undefined
  // Fallback anchor one request behind the projection: the newest request's prompt plus the heuristic
  // movement since; the split-generation head carries it as `last`, the inline generation its newest record.
  const last = data.last
  const requests = data.requests
  const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
  const anchor = last !== undefined ? last : lastReq
  const derived = anchor !== null && typeof anchor.prompt === 'number'
    ? anchor.prompt + (current.total - anchor.total)
    : undefined
  const occupancyTokens = projected ?? sampled ?? derived ?? null
  const window = pressure !== null && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : data.contextWindow
  const tokens = occupancyTokens ?? current.total
  const pct = window !== undefined && window > 0 ? occupancyPercent(tokens, window) : null
  const parts = anchoredParts(
    officialParts(current, breakdown),
    occupancyTokens !== null && tokens > 0 ? tokens : null,
  )
  const reserve = reserveGeometry(window, data.maxOutputTokens)
  return { tokens, window, pct, parts, ...(reserve !== undefined ? { reserve } : {}) }
}
