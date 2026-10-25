import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import type { ContextReserve } from '../reserve'
import type { ViewKit } from '../viewkit'

/** Entrance-stagger cap: a long DNA band list joins within the cap (`stackedBar.css` delays by `--lc-i`). */
const STAGGER_CAP = 8

/** Above this many parts the entrance animation is dropped: past it a band is under ~1.5px on the narrowest pane, so
 *  the scale-in cannot be seen, while thousands of CSS animations cost the DNA toggle a few hundred ms of style work. */
export const SEGMENT_ANIMATION_MAX = 256

interface ReserveMask {
  key: 'headroom' | 'output'
  label: string
  tokens: number
  left: number
  width: number
}

interface BarTip {
  head: string
  figure: string
  note?: string
  leftPct: number
}

export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onPickKey?: (key: string) => void
  /** Minimum width each segment keeps, as a share of the OCCUPIED region. Bands below the floor pin to it and the
   * rest rescale; the floor caps at the equal split (100/N). Tooltips keep reporting TRUE shares. */
  minBand?: number
  /** Render the hover tooltip (default true); a mirroring bar turns it off so no tip floats off its own surface. */
  tip?: boolean
  /** Auto-compaction reserve (reserve.ts derives the geometry): masks tiling the window's tail — headroom, then
   * output — plus the trigger line when it detaches; in WINDOW tokens, only when `max` is positive. */
  reserve?: ContextReserve
}

export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactElement {
    const [reserveOn, setReserveOn] = useState<ReserveMask['key'] | 'trigger' | null>(null)
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const tipRef = useRef<HTMLDivElement | null>(null)
    const [tipShift, setTipShift] = useState(0)
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0
    // Segment WIDTHS lay out against the full window (scale), but legend/tooltip percentages are shares of the OCCUPIED total.
    const usedPct = scale > 0 ? total / scale * 100 : 0
    const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    const showBox = free > 0 && hovering
    const pickKey = props.onPickKey
    const minBand = props.minBand !== undefined && props.minBand > 0 ? props.minBand : 0

    // Segments with their BAR-unit widths, floored in occupied units: pinned bands take the floor, the rest rescale.
    // The floor ≤ 100/N keeps one band unpinned, so `restRaw` never divides by zero.
    const visible = total > 0 ? props.parts.filter(p => p.value > 0) : []
    const animate = visible.length <= SEGMENT_ANIMATION_MAX
    const widths = ((): number[] => {
      if (minBand === 0 || visible.length < 2) return visible.map(p => p.value / scale * 100)
      const shares = visible.map(p => p.value / total * 100)
      const floor = Math.min(minBand, 100 / visible.length)
      let pinned = 0
      let pinnedRaw = 0
      for (const s of shares) {
        if (s < floor) { pinned += 1; pinnedRaw += s }
      }
      if (pinned === 0) return visible.map(p => p.value / scale * 100)
      const restRoom = 100 - pinned * floor
      const restRaw = 100 - pinnedRaw
      return shares.map(s => (s < floor ? floor : s * restRoom / restRaw) * total / scale)
    })()

    // The masks lay out in WINDOW units scaled onto the bar's track, so they keep the same physical slice with or
    // without a free track; a mask too narrow to hover is dropped rather than rendered sub-pixel.
    const win = props.max !== undefined && props.max > 0 ? props.max : undefined
    const reserve = win === undefined ? undefined : props.reserve
    const trackPct = (tokens: number): number => Math.round(Math.max(0, Math.min(100, tokens / scale * 100)) * 10) / 10
    // Read the trigger off the same projection the masks use — clamped to the window, so no impossible percent reaches the copy.
    const triggerPct = reserve === undefined ? 0 : trackPct(reserve.threshold)
    const masks: ReserveMask[] = []
    let triggerDetached = false
    if (reserve !== undefined && win !== undefined) {
      const maskStart = win - reserve.output - reserve.headroom
      const pieces = [
        { key: 'headroom' as const, label: t('overview.reserveHeadroom'), tokens: reserve.headroom, from: maskStart },
        { key: 'output' as const, label: t('overview.reserveOutput'), tokens: reserve.output, from: win - reserve.output },
      ]
      for (const piece of pieces) {
        const left = trackPct(piece.from)
        const width = trackPct(piece.from + piece.tokens) - left
        if (width > 0) masks.push({ key: piece.key, label: piece.label, tokens: piece.tokens, left, width })
      }
      triggerDetached = reserve.threshold < maskStart
    }

    const enterReserve = (key: ReserveMask['key'] | 'trigger') => (): void => {
      setReserveOn(key)
      if (props.onHoverKey !== undefined) props.onHoverKey(null)
    }
    const leaveReserve = (): void => { setReserveOn(null) }

    // The tooltip is DERIVED from the shared hover key (a legend chip and its segment light the same one); a hovered
    // reserve piece overrides the slot. Every figure names its denominator: segments share USED, the free/trigger WINDOW.
    let tip: BarTip | null = null
    const hoveredMask = reserveOn === null ? undefined : masks.find(m => m.key === reserveOn)
    if (reserveOn === 'trigger' && reserve !== undefined && triggerDetached) {
      tip = {
        head: t('overview.reserveTrigger'),
        figure: `${fmt(reserve.threshold)} · ${triggerPct}% ${t('overview.ofWindow')}`,
        note: t('overview.reserveTriggerTip'),
        leftPct: triggerPct,
      }
    } else if (hoveredMask !== undefined) {
      tip = {
        head: hoveredMask.label,
        figure: fmt(hoveredMask.tokens),
        note: hoveredMask.key === 'headroom'
          ? (triggerDetached ? t('overview.reserveHeadroomBuffer') : t('overview.reserveHeadroomTip', { p: triggerPct }))
          : t('overview.reserveOutputTip'),
        leftPct: hoveredMask.left + hoveredMask.width / 2,
      }
    } else if (props.hoverKey !== null && props.hoverKey !== undefined) {
      if (props.hoverKey === 'free' && free > 0) {
        const pct = scale > 0 ? free / scale * 100 : 0
        tip = {
          head: t('overview.free'),
          figure: `${fmt(free)} · ${Math.round(pct)}% ${t('overview.ofWindow')}`,
          leftPct: (total / scale * 100) + pct / 2,
        }
      } else {
        let acc = 0
        // Counts come from the part's heuristic `raw` figure; widths ride the floored `widths` so the tip centers on the RENDERED segment.
        let rawTotal = 0
        for (const p of props.parts) rawTotal += p.raw ?? p.value
        for (let i = 0; i < visible.length; i++) {
          const p = visible[i]
          if (p.key === props.hoverKey) {
            const count = p.raw ?? p.value
            tip = {
              head: p.label ?? catLabel(p.key),
              figure: `≈${fmt(count)} · ${rawTotal > 0 ? Math.round(count / rawTotal * 100) : 0}% ${t('overview.ofUsed')}`,
              leftPct: acc + widths[i] / 2,
            }
            break
          }
          acc += widths[i]
        }
      }
    }

    // The percentage anchor stays the source of truth; the px shift only fires when the rows would overhang the bar.
    // Rects, not clientWidth: the latter truncates to a whole pixel and the residue lands back on the overhang.
    useLayoutEffect(() => {
      // No visible tip → no measurement; reading layout here would flush the whole page's layout for nothing.
      if (tip === null) {
        setTipShift(prev => (prev === 0 ? prev : 0))
        return
      }
      /* v8 ignore next -- unreachable: the wrap commits its ref before layout effects run. */
      const wrapW = wrapRef.current === null ? 0 : wrapRef.current.getBoundingClientRect().width
      const tipW = tipRef.current === null ? 0 : tipRef.current.getBoundingClientRect().width
      setTipShift((prev) => {
        if (wrapW <= 0 || tipW <= 0) return prev === 0 ? prev : 0
        const center = tip.leftPct / 100 * wrapW
        const leftOver = tipW / 2 - center
        const rightOver = center + tipW / 2 - wrapW
        const next = leftOver > 0 ? Math.ceil(leftOver) : rightOver > 0 ? Math.ceil(-rightOver) : 0
        return next === prev ? prev : next
      })
    })

    const shift = tipShift === 0
      ? null
      : { transform: `translateX(calc(-50% ${tipShift > 0 ? '+' : '-'} ${Math.abs(tipShift)}px))` }
    const tipStyle = tip === null ? { left: '50%' } : { left: `${tip.leftPct}%`, ...shift }

    return (
      <div className="lc-stacked-wrap" ref={wrapRef}>
        <div
          className={'lc-stacked' + (hovering ? ' lc-stacked-dim' : '')}
          style={{ height: `${props.height || 14}px` }}
          onMouseLeave={() => {
            if (props.onHoverKey !== undefined) props.onHoverKey(null)
            setReserveOn(null)
          }}
        >
          {visible.map((p, i) => {
            // Exact-key hover lights the one segment; a part's `group` answers a mirrored CATEGORY hover (DNA bands light per category).
            const on = props.hoverKey !== undefined
              && (props.hoverKey === p.key || (p.group !== undefined && props.hoverKey === p.group))
            return (
              <div
                key={p.key}
                className={'lc-stacked-seg' + (animate ? ' animate-lc-stacked-in motion-reduce:animate-none' : '') + (on ? ' lc-stacked-seg-on' : '') + (pickKey !== undefined ? ' lc-stacked-seg-pick' : '')}
                style={{ width: `${widths[i]}%`, backgroundColor: p.color, ...(animate ? { '--lc-i': Math.min(i, STAGGER_CAP) } : {}) }}
                onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                onClick={pickKey !== undefined ? () => { pickKey(p.key) } : undefined}
              />
            )
          })}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free animate-lc-stacked-in motion-reduce:animate-none' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              style={{ width: `${free / scale * 100}%`, '--lc-i': Math.min(visible.length, STAGGER_CAP + 1) } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {masks.map(m => (
            <div
              key={m.key}
              className={`lc-reserve lc-reserve-${m.key}`}
              style={{ left: `${m.left}%`, width: `${m.width}%` }}
              onMouseEnter={enterReserve(m.key)}
              onMouseLeave={leaveReserve}
            />
          ))}
          {triggerDetached ? (
            <div
              className="lc-trigger"
              style={{ left: `${triggerPct}%` }}
              onMouseEnter={enterReserve('trigger')}
              onMouseLeave={leaveReserve}
            />
          ) : null}
          {/* Occupied-region frame: painted last to stay above the segments, always mounted so it fades out. */}
          <div
            className={'lc-occupied-box' + (showBox ? ' lc-occupied-box-on' : '')}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        {/* Always mounted (opacity via `.lc-bar-tip-on`) so it fades in and out; hidden it holds no pointer events. */}
        {props.tip !== false
          ? (
            <div
              ref={tipRef}
              className={'lc-tip lc-bar-tip' + (tip ? ' lc-bar-tip-on' : '')}
              role={tip === null ? undefined : 'tooltip'}
              style={tipStyle}
            >
              {tip === null ? null : (
                <>
                  <b className="lc-bar-tip-head">{tip.head}</b>
                  <span className="lc-bar-tip-fig">{tip.figure}</span>
                  {tip.note !== undefined ? <span className="lc-bar-tip-note">{tip.note}</span> : null}
                </>
              )}
            </div>
          )
          : null}
      </div>
    )
  }
}

export interface LegendProps {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** Signed figures (Delta mode): the count prints with sign and color, and the share drops out — a signed change has no share. */
  delta?: boolean
}

export function makeLegend(kit: ViewKit): (props: LegendProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function Legend(props: LegendProps): ReactElement {
    let total = 0
    for (const p of props.parts) total += p.raw ?? p.value
    return (
      <div className="lc-legend">
        {props.parts.map((p) => {
          const count = p.raw ?? p.value
          const on = props.hoverKey !== undefined && props.hoverKey === p.key
          const sign = props.delta === true && count !== 0 ? ' lc-chip-nums-' + (count > 0 ? 'up' : 'down') : ''
          return (
            <span
              key={p.key}
              className={'lc-chip' + (on ? ' lc-chip-on' : '')}
              title={props.delta === true ? undefined : t('overview.ofUsed')}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
              onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
            >
              <i style={{ background: p.color }} />
              <span className="lc-chip-label">{catLabel(p.key)}</span>
              <span className={'lc-chip-nums' + sign}>
                {props.delta === true ? (count > 0 ? '+' : '') + fmt(count) : '≈' + fmt(count)}
                {props.delta !== true && total > 0 ? <em>{`${Math.round(count / total * 100)}%`}</em> : null}
              </span>
            </span>
          )
        })}
      </div>
    )
  }
}
