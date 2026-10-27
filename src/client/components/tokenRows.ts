import type { PartsPart } from '../categories'
import type { ViewKit } from '../viewkit'
import type { SliceRow } from './sliceList'

export function tokenRowsOf(kit: ViewKit, parts: readonly PartsPart[], total: number): SliceRow[] {
  const { t, fmt, fmtShare, catLabel } = kit
  return parts.map(p => ({
    key: p.key,
    color: p.color,
    label: p.key === 'thinking' ? t('tokens.thinking') : catLabel(p.key),
    pct: fmtShare(p.value, total),
    count: '≈' + fmt(p.value),
  }))
}
