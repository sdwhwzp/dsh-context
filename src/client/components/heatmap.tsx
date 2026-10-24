/** Insights activity heatmap: a GitHub-style contribution grid (weeks as columns, Sunday-first days) over the merged
 * daily ledger; a day with data pins the session list to that day. The injected `today` key keeps the layout
 * deterministic in tests and follows the browser's local calendar at runtime. */

import type { ReactElement } from 'react'
import { dayKeyOf, shiftDayKey, sundayOfWeek } from '../../shared/days'
import { type DayTotals } from '../overview'
import type { ViewKit } from '../viewkit'

export type HeatMetric = 'sessions' | 'tokens'

export interface HeatmapProps {
  days: Record<string, DayTotals>
  weeks?: number
  metric?: HeatMetric
  selected?: string | null
  /** Day-pin relay; a data-less day is inert. */
  onSelect?: (day: string | null) => void
  /** The local today key (injected so specs pin the calendar). */
  today: string
}

interface HeatCell {
  key: string
  entry?: DayTotals
  future: boolean
}

/** Lay out `weeks` columns ending at today's week, seven Sunday-first cells each. Returns null when `today` (or its
 * week math) fails — a corrupt injected key degrades the card to its empty note. */
export function gridOf(today: string, weeks: number): HeatCell[][] | null {
  const lastSunday = sundayOfWeek(today)
  if (lastSunday === null || weeks < 1) return null
  const firstSunday = shiftDayKey(lastSunday, -7 * (weeks - 1))
  if (firstSunday === null) return null
  const columns: HeatCell[][] = []
  for (let w = 0; w < weeks; w++) {
    const sunday = shiftDayKey(firstSunday, 7 * w)
    /* v8 ignore next -- sunday is bounded by firstSunday and lastSunday (both
     * proven valid), so it can never leave the representable range; kept as a
     * guard so a future shiftDayKey change cannot leak a null into the grid. */
    if (sunday === null) return null
    const column: HeatCell[] = []
    for (let d = 0; d < 7; d++) {
      const key = shiftDayKey(sunday, d)
      if (key === null) return null
      column.push({ key, future: key > today, entry: undefined })
    }
    columns.push(column)
  }
  return columns
}

function levelOf(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

export function makeHeatmap(kit: ViewKit): (props: HeatmapProps) => ReactElement {
  const { t, fmt } = kit
  return function Heatmap(props: HeatmapProps): ReactElement {
    const weeks = props.weeks ?? 8
    const metric = props.metric ?? 'tokens'
    const columns = gridOf(props.today, weeks)
    if (columns === null) return <div className="lc-empty">{t('ov.heat.empty')}</div>
    const byKey: Record<string, DayTotals | undefined> = props.days
    let maxSessions = 0
    let maxTokens = 0
    let any = false
    for (const column of columns) {
      for (const cell of column) {
        const entry = byKey[cell.key]
        if (entry === undefined || (entry.tokens <= 0 && entry.requests <= 0)) continue
        cell.entry = entry
        any = true
        // Independent maxima: one long session drops a block of tokens a day while another day stacks many sessions,
        // so neither metric scales off the other's peak.
        if (entry.sessions > maxSessions) maxSessions = entry.sessions
        if (entry.tokens > maxTokens) maxTokens = entry.tokens
      }
    }
    if (!any) return <div className="lc-empty">{t('ov.heat.empty')}</div>
    const max = metric === 'sessions' ? maxSessions : maxTokens
    const metricValueOf = (entry: DayTotals): number => (metric === 'sessions' ? entry.sessions : entry.tokens)
    // Keyed BY the Sunday-first row index (0=Sun..6=Sat): the label sits on the row it names, so no row arithmetic shifts it.
    const weekdayLabels: Record<number, string> = { 1: t('ov.heat.wd.1'), 3: t('ov.heat.wd.3'), 5: t('ov.heat.wd.5') }
    return (
      <div className="lc-heat-wrap">
        <div className="lc-heat" role="group" aria-label={t('ov.heat.title')}>
          <div className="lc-heat-wds" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map(row => (
              <span key={row} className="lc-heat-wd">{weekdayLabels[row] ?? ''}</span>
            ))}
          </div>
          <div className="lc-heat-cols">
            {columns.map((column, wi) => {
              // A column is labeled when a month BEGINS inside it: the month changes between its Sunday and Saturday,
              // or its Sunday IS the 1st. The label names the Saturday's month; the window's first column is always labeled.
              const opens = wi === 0 || column[0].key.slice(0, 7) !== column[6].key.slice(0, 7) || column[0].key.slice(8, 10) === '01'
              return (
                <div key={wi} className="lc-heat-col">
                  {opens && <span className="lc-heat-mon" aria-hidden="true">{t('ov.heat.mon.' + column[6].key.slice(5, 7))}</span>}
                  {column.map((cell) => {
                    if (cell.future) return <span key={cell.key} className="lc-heat-cell lc-heat-future" aria-hidden="true" />
                    const level = cell.entry === undefined ? 0 : levelOf(metricValueOf(cell.entry), max)
                    if (cell.entry === undefined) {
                      return <span key={cell.key} className="lc-heat-cell lc-heat-0" data-lc-tip={cell.key} />
                    }
                    const picked = props.selected === cell.key
                    const label = `${cell.key}\n${t('ov.heat.sessions', { n: cell.entry.sessions })}\n${t('ov.heat.tokens', { n: fmt(cell.entry.tokens) })}`
                    return (
                      <button
                        key={cell.key}
                        type="button"
                        className={`lc-heat-cell lc-heat-${String(level)}${picked ? ' lc-heat-on' : ''}`}
                        data-lc-tip={label}
                        aria-label={label}
                        aria-pressed={picked}
                        onClick={() => { if (props.onSelect !== undefined) props.onSelect(picked ? null : cell.key) }}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
        {/* The Less→More key reuses the grid's own depth classes, so it can never drift from the cells. */}
        <div className="lc-heat-legend" aria-hidden="true">
          <span className="lc-heat-key">{t('ov.heat.less')}</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className={`lc-heat-cell lc-heat-${String(level)}`} />
          ))}
          <span className="lc-heat-key">{t('ov.heat.more')}</span>
        </div>
      </div>
    )
  }
}

export function todayKey(): string {
  /* v8 ignore next -- Date.now() is always a valid local day, so the null
   * arm of dayKeyOf is unreachable here; the '' fallback only types the seam. */
  return dayKeyOf(Date.now()) ?? ''
}
