/** The browser's DNA mode: one band per assembled-context item in PROMPT order. The header epoch's `seq`
 * is NOT an ordering key: dsh appends `request/header` at the first dispatch, after the messages already there. */

import type { Category, SurfaceNode } from '../shared/types'
import type { Assembled } from './assemble'
import { CAT_COLOR } from './categories'
import type { Translate } from './i18n'

export type DnaItem =
  | { key: string; cat: 'system' | 'tools'; tokens: number; time?: number }
  | { key: string; cat: Category; tokens: number; time?: number; node: SurfaceNode }

export function dnaOf(view: Assembled): DnaItem[] {
  const items: DnaItem[] = []
  if (view.system !== null) {
    items.push({ key: 'sys', cat: 'system', tokens: view.system.tokens, time: view.system.time })
  }
  if (view.header !== null) {
    for (const tool of view.header.tools) {
      items.push({ key: 'tool:' + tool.name, cat: 'tools', tokens: tool.tokens })
    }
  }
  // Zero-token items keep their band: the bar drops zero widths, the reading order stays truthful.
  for (const n of view.nodes) {
    items.push({
      key: 'n' + String(n.seq),
      cat: n.cat,
      tokens: n.tokens,
      node: n,
      ...(n.time !== undefined ? { time: n.time } : {}),
    })
  }
  return items
}

/** One band of a TREND CHART bar's gradient: the decomposition plus color and cumulative `off`. */
export type TrendBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

export function trendBandsOf(view: Assembled): TrendBand[] {
  const bands: TrendBand[] = []
  let off = 0
  for (const it of dnaOf(view)) {
    if ('node' in it) {
      bands.push({ key: it.key, cat: it.cat, tokens: it.tokens, off, color: CAT_COLOR[it.cat], node: it.node })
    } else {
      bands.push({ key: it.key, cat: it.cat, tokens: it.tokens, off, color: CAT_COLOR[it.cat] })
    }
    off += it.tokens
  }
  return bands
}

/** DNA mode's DELTA view: per-item differences of two band lists paired by key. `tokens` is signed (up
 * positive); `off` is the cumulative magnitude from the zero line. */
export type DeltaBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

export interface DnaDelta {
  up: DeltaBand[]
  down: DeltaBand[]
}

export function deltaBandsOf(bands: TrendBand[], prev: TrendBand[] | null): DnaDelta {
  // A null predecessor is no baseline: the scale stays change-driven rather than pinned by the opening bulk.
  if (prev === null) return { up: [], down: [] }
  const before = new Map(prev.map(b => [b.key, b.tokens] as const))
  const after = new Map(bands.map(b => [b.key, b.tokens] as const))
  const up: DeltaBand[] = []
  const down: DeltaBand[] = []
  for (const b of bands) {
    const d = b.tokens - (before.get(b.key) ?? 0)
    if (d <= 0) continue
    up.push('node' in b
      ? { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color, node: b.node }
      : { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color })
  }
  for (const b of prev) {
    const d = (after.get(b.key) ?? 0) - b.tokens
    if (d >= 0) continue
    down.push('node' in b
      ? { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color, node: b.node }
      : { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color })
  }
  let u = 0
  for (const x of up) { x.off = u; u += x.tokens }
  let dn = 0
  for (const x of down) { x.off = dn; dn -= x.tokens }
  return { up, down }
}

export function dnaBaseLabel(b: DnaItem | TrendBand | DeltaBand, t: Translate, catLabel: (key: string) => string): string {
  if (!('node' in b)) return b.cat === 'system' ? catLabel('system') : b.key.slice('tool:'.length)
  const n = b.node
  return n.skill !== undefined ? t('node.skillTag', { name: n.skill })
    : n.cat === 'tool' ? (n.tool ?? '?')
      : n.cat === 'inject' ? t('form.' + (n.form || 'context'))
        : catLabel(n.cat)
}
