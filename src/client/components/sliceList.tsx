import { type ReactElement } from 'react'

export interface SliceRow {
  key: string
  color: string
  label: string
  /** Preformatted share, e.g. '84%' or '—'. */
  pct: string
  /** Preformatted secondary line; empty omits it. */
  count: string
  /** A zero-figure slice dims whole; the owning card decides whether its row still renders. */
  dim?: boolean
}

export interface SliceListProps {
  rows: SliceRow[]
  hoverKey?: string | null
  /** Absent renders the rows inert. */
  onHoverKey?: (key: string | null) => void
}

export function SliceList(props: SliceListProps): ReactElement {
  return (
    <div className="lc-sl flex-auto @max-[240px]/lc-card:basis-full" onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}>
      {props.rows.map(r => (
        <div
          key={r.key}
          className={'lc-sl-row'
            + (r.dim ? ' lc-sl-row-dim' : '')
            + (props.hoverKey !== undefined && props.hoverKey === r.key ? ' lc-sl-row-on' : '')}
          onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(r.key) }}
        >
          <div className="lc-sl-main">
            <i className="lc-sl-dot" style={{ background: r.color }} />
            <span className="lc-sl-label" title={r.label}>{r.label}</span>
            <span className="lc-sl-pct">{r.pct}</span>
          </div>
          {r.count !== '' ? <div className="lc-sl-sub" title={r.count}>{r.count}</div> : null}
        </div>
      ))}
    </div>
  )
}
