import { useState, type ReactElement } from 'react'
import type { TokenPartTotal } from '../overview'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps } from './donut'

export function makeOverviewTokens(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  /** Category-folded billed split; null when nothing billed. */
  tokens: { parts: TokenPartTotal[]; total: number } | null
}) => ReactElement {
  const { t, fmt, fmtShare, catLabel } = kit
  return function OverviewTokens(props: { tokens: { parts: TokenPartTotal[]; total: number } | null }): ReactElement {
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const tokens = props.tokens
    const total = tokens?.total ?? 0
    // Zero categories hide once anything is billed (the per-session card's convention); nothing billed shows the empty note.
    const shown = tokens !== null && total > 0 ? tokens.parts.filter(p => p.value > 0) : []
    const rows: SliceRow[] = shown.map(p => ({
      key: p.key,
      color: p.color,
      label: p.key === 'output' ? t('tokens.output') : catLabel(p.key),
      pct: fmtShare(p.value, total),
      // Category counts are summed per-session ratio estimates (≈); the output figure is provider-exact.
      count: p.key === 'output' ? `${fmt(p.value)} · ${t('tokens.outputNote')}` : '≈' + fmt(p.value),
    }))
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('tokens.title')}</span>
        </div>
        {shown.length === 0
          ? <div className="lc-empty">{t('ov.stats.empty')}</div>
          : (
            <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
              <Donut
                segments={shown.map(p => ({ key: p.key, color: p.color, value: p.value }))}
                size={96}
                centerTop={fmt(total)}
                centerSub={t('tokens.total')}
                hoverKey={hoverKey}
                onHoverKey={setHoverKey}
              />
              <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
            </div>
          )}
      </div>
    )
  }
}
