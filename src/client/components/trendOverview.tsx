/** The trend card's Overview face: the whole retained log as one continuous stacked ribbon, not compressed columns
 * (sub-pixel slivers would layerize at ~1500 steps); mutually exclusive with DNA mode and Adaptive. */

import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS, CAT_COLOR } from '../categories'
import { RISE_CLASS, TURN_FILLS, preprocessTrend, trendMaxima, turnStepsOf, trendTipRows } from './trendChart'
import type { ViewKit } from '../viewkit'

export interface TrendOverviewProps {
  requests: RequestRecord[]
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  activeTurn: number | null
  granularity: 'step' | 'turn'
  mode: 'total' | 'delta'
  hoverCat: string | null
  focusCat?: string | null
  durationCurve?: boolean
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onPickCat?: (cat: Category | 'system' | 'tools', seq: number) => void
}

/** X flags sit on the three quartiles plus the full span: the log's start collapses into the pane edge, so the 0 pole is unshowable. */
const FLAG_FRACS: readonly number[] = [0.25, 0.5, 0.75, 1]

const CHART_H = 112

/** The ribbon's plot starts this far below the surface's box (`.lc-chart` top padding in trendChart.css). */
const PLOT_TOP = 18

/** The drawn y of a cumulate, rounded to the svg's hundredth of a px. Shared by the polygon path and the band hit-test,
 * so a change to the axis can never desync paint from hit-testing. */
const yOf = (cum: number, scale: number, baseline: number, dir: 1 | -1): number =>
  Math.round((baseline - dir * cum * scale) * 100) / 100

interface RibbonBand {
  cat: Category | 'system' | 'tools'
  upper: number[]
  lower: number[]
  /** +1 for bands growing up from the baseline, −1 for the down arm. */
  dir: 1 | -1
  points: string
}

interface RibbonGeometry {
  maxTotal: number
  maxUp: number
  maxDown: number
  upPx: number
  span: number
  maxActiveMs: number
  baseline: number
  scale: number
  bands: RibbonBand[]
  durationRuns: string[]
  durationDots: [number, number][]
}

/** The ribbon's full drawing geometry in one pure pass: maxima, band polygons, duration runs/dots. Module-scope so the
 * component memoizes it on [requests, mode, duration]; a hover-driven render never rebuilds them. */
function ribbonGeometry(requests: RequestRecord[], delta: boolean, durationOn: boolean): RibbonGeometry {
  const n = requests.length
  const geo: RibbonGeometry = {
    maxTotal: 1,
    maxUp: 0,
    maxDown: 0,
    upPx: 0,
    span: 1,
    maxActiveMs: 0,
    baseline: 0,
    scale: 1,
    bands: [],
    durationRuns: [],
    durationDots: [],
  }
  if (n === 0) return geo
  ;({ maxTotal: geo.maxTotal, maxUp: geo.maxUp, maxDown: geo.maxDown } = trendMaxima(requests, delta))
  const span = Math.max(1, geo.maxUp + geo.maxDown)
  const deltaScale = CHART_H / span
  geo.span = span
  geo.upPx = Math.round(geo.maxUp * deltaScale)
  // The svg maps x in viewBox units (one per record, stretched edge to edge) and y in px: the 112 viewBox height equals
  // the rendered height, so vertical figures stay px-exact. A single record closes its bands across the full unit width.
  const u = n > 1 ? n - 1 : 1
  const xs: number[] = n === 1 ? [0, u] : Array.from({ length: n }, (_, i) => i)
  const cumAt = (v: number[], x: number): number => v[n === 1 ? 0 : x]
  /** A band's closed polygon (upper cumulate forward, lower reversed); a zero-width band is dropped — the neighbor's
   * fill already paints the shared boundary. `upper` is the visually-upper edge at `dir`. */
  const ribbon = (cat: RibbonBand['cat'], upper: number[], lower: number[], dir: 1 | -1): void => {
    let width = 0
    for (let i = 0; i < n; i++) {
      const d = Math.abs(upper[i] - lower[i])
      if (d > width) width = d
    }
    if (width <= 0) return
    const pts: string[] = []
    for (const x of xs) pts.push(`${x},${yOf(cumAt(upper, x), geo.scale, geo.baseline, dir)}`)
    for (let k = xs.length - 1; k >= 0; k--) pts.push(`${xs[k]},${yOf(cumAt(lower, xs[k]), geo.scale, geo.baseline, dir)}`)
    // The stack loop mutates the live cumulate arrays for the next category: copy them for hit-testing.
    geo.bands.push({ cat, upper: [...upper], lower: [...lower], dir, points: pts.join(' ') })
  }
  if (delta) {
    geo.baseline = geo.upPx
    geo.scale = deltaScale
    const up = new Array<number>(n).fill(0)
    const down = new Array<number>(n).fill(0)
    for (const c of CATS) {
      const upPrev = up.slice()
      const downPrev = down.slice()
      for (let i = 0; i < n; i++) {
        const d = requests[i][c.key] || 0
        up[i] += Math.max(0, d)
        down[i] += Math.max(0, -d)
      }
      ribbon(c.key, up, upPrev, 1)
      ribbon(c.key, downPrev, down, -1)
    }
  } else {
    geo.baseline = CHART_H
    geo.scale = CHART_H / geo.maxTotal
    const acc = new Array<number>(n).fill(0)
    for (const c of CATS) {
      const prev = acc.slice()
      for (let i = 0; i < n; i++) acc[i] += requests[i][c.key] || 0
      ribbon(c.key, acc, prev, 1)
    }
  }
  if (durationOn) {
    // The right-hand axis plots raw active time, whole-log by construction. A bar without `activeMs` breaks the run;
    // an isolated single point needs a dot — a one-point polyline renders invisible.
    let maxActiveMs = 0
    for (const req of requests) {
      const m = req.activeMs ?? 0
      if (m > maxActiveMs) maxActiveMs = m
    }
    geo.maxActiveMs = maxActiveMs
    const scale = CHART_H / Math.max(1, maxActiveMs)
    let run: [number, number][] = []
    const flushRun = (): void => {
      if (run.length >= 2) geo.durationRuns.push(run.map(p => `${p[0]},${p[1]}`).join(' '))
      else if (run.length === 1) geo.durationDots.push(run[0])
      run = []
    }
    for (let i = 0; i < n; i++) {
      const m = requests[i].activeMs
      if (m === undefined) {
        flushRun()
        continue
      }
      run.push([i, yOf(m, scale, CHART_H, 1)])
    }
    flushRun()
  }
  return geo
}

/** The painted band under `y` px at fractional position `f`: both edges interpolate as the polygon does, so the lit band
 * is the one under the pointer — not the nearest record's. */
function bandAt(geo: RibbonGeometry, f: number, n: number, y: number): RibbonBand['cat'] | null {
  const i0 = Math.min(n - 1, Math.floor(f))
  const i1 = Math.min(n - 1, i0 + 1)
  const t = f - i0
  const at = (v: number[]): number => v[i0] + (v[i1] - v[i0]) * t
  for (const band of geo.bands) {
    const a = yOf(at(band.upper), geo.scale, geo.baseline, band.dir)
    const b = yOf(at(band.lower), geo.scale, geo.baseline, band.dir)
    if (y >= Math.min(a, b) && y <= Math.max(a, b)) return band.cat
  }
  return null
}

/** The turn strip's labeled groups: the group holding each width quartile of the record span, deduped. */
function wideQuartiles(groups: { count: number }[]): number[] {
  const total = groups.reduce((s, g) => s + g.count, 0)
  const picks: number[] = []
  for (const q of FLAG_FRACS) {
    let acc = 0
    let pick = groups.length - 1
    for (let g = 0; g + 1 < groups.length; g++) {
      acc += groups[g].count
      if (acc > q * total) {
        pick = g
        break
      }
    }
    if (!picks.includes(pick)) picks.push(pick)
  }
  return picks
}

export function makeTrendOverview(kit: ViewKit): (props: TrendOverviewProps) => ReactElement | null {
  const { eventLabel, eventAt } = kit

  // Mirrored by .lc-axis-q1/.lc-axis-q3 in trendChart.css (the bars' own mapping; see trendChart.tsx).
  const Q3_TOP = 41
  const Q1_TOP = 97
  const fmtSigned = (v: number): string => (v > 0 ? '+' : '') + kit.fmt(v)

  return function TrendOverview(props: TrendOverviewProps): ReactElement | null {
    const delta = props.mode === 'delta'
    const durationOn = props.durationCurve === true
    const { requests, focus } = useMemo(
      () => preprocessTrend(props.requests, delta, props.focusCat),
      [props.requests, delta, props.focusCat],
    )
    const n = requests.length
    const geo = useMemo(() => ribbonGeometry(requests, delta, durationOn), [requests, delta, durationOn])
    const surfaceRef = useRef<HTMLDivElement | null>(null)
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const lastIdxRef = useRef<number | null>(null)
    const lastCatRef = useRef<RibbonBand['cat'] | null>(null)
    // Pointer hover is local (the bars' idiom): the tip and cursor track it while the parent's preview follows a
    // throttle/transition; the band under the pointer also rides local state, since a relay would re-render per band.
    const [localHover, setLocalHover] = useState<number | null>(null)
    const [localCat, setLocalCat] = useState<RibbonBand['cat'] | null>(null)
    const hoverSeq = localHover ?? props.hoveredSeq
    const handleHover = useCallback((seq: number | null): void => {
      setLocalHover(seq)
      props.onHover(seq)
    }, [props.onHover])
    if (n === 0) return null
    // Blocks grow ∝ the RECORDS they span — the ribbon's own x unit: a step counts one, and turn granularity's one-record-per-turn
    // aggregates stay equal width.
    const u = n > 1 ? n - 1 : 1
    const groups: { turn: number; count: number; first: number }[] = []
    for (let i = 0; i < n; i++) {
      const req = requests[i]
      let grp = groups.length > 0 ? groups[groups.length - 1] : null
      if (grp === null || grp.turn !== (req.turn ?? 0)) {
        grp = { turn: req.turn ?? 0, count: 0, first: i }
        groups.push(grp)
      }
      grp.count++
    }
    // Quartile + full-span flags, deduped (see FLAG_FRACS): labeled with a step's 1-based position or the turn it lands on.
    const flagRecords = [...new Set(FLAG_FRACS.map(q => Math.round(q * (n - 1))))].filter(idx => idx > 0)
    const flagLabel = (idx: number): number => (props.granularity === 'step' ? idx + 1 : requests[idx].turn ?? 0)
    const flagGroups = wideQuartiles(groups)
    // A delta quarter mark yields when its label box would overlap the zero label (see trendChart.tsx).
    const q3Clear = Math.abs(Q3_TOP - 13 - geo.upPx) >= 11
    const q1Clear = Math.abs(Q1_TOP - 13 - geo.upPx) >= 11

    // The active turn's plot range: half a step past each end record, clamped to the ribbon's edges.
    let wash: { left: string; right: string } | null = null
    if (props.activeTurn !== null) {
      const wi = groups.findIndex(g => g.turn === props.activeTurn)
      if (wi >= 0) {
        const end = groups[wi].first + groups[wi].count - 1
        const left = groups[wi].first === 0 ? 0 : (groups[wi].first - 0.5) / u * 100
        const right = end === n - 1 ? 100 : (end + 0.5) / u * 100
        wash = { left: `${left}%`, right: `${100 - right}%` }
      }
    }

    /** The pointer's fractional record position: one unit per record, clamped to the ribbon's edges. A zero-width rect (jsdom) reads as
     * the first record. */
    const xAt = (rect: { width: number; left: number }, clientX: number): number => {
      if (rect.width <= 0) return 0
      const fx = (clientX - rect.left) / rect.width
      return Math.min(u, Math.max(0, fx * u))
    }
    const idxOf = (x: number): number => Math.min(n - 1, Math.round(x))
    const onMove = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = xAt(rect, e.clientX)
      const idx = idxOf(x)
      if (lastIdxRef.current !== idx) {
        lastIdxRef.current = idx
        handleHover(requests[idx].seq)
      }
      const cat = bandAt(geo, x, n, e.clientY - rect.top - PLOT_TOP)
      if (lastCatRef.current !== cat) {
        lastCatRef.current = cat
        setLocalCat(cat)
      }
    }
    const onLeave = (): void => {
      lastIdxRef.current = null
      lastCatRef.current = null
      setLocalCat(null)
      handleHover(null)
    }
    const onClick = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = xAt(rect, e.clientX)
      const seq = requests[idxOf(x)].seq
      const cat = bandAt(geo, x, n, e.clientY - rect.top - PLOT_TOP)
      if (cat !== null && props.onPickCat !== undefined) props.onPickCat(cat, seq)
      props.onSelect(props.selectedSeq === seq ? null : seq)
    }

    const hoveredIdx = hoverSeq !== null ? requests.findIndex(r => r.seq === hoverSeq) : -1
    const selectedIdx = props.selectedSeq !== null ? requests.findIndex(r => r.seq === props.selectedSeq) : -1
    const stepsOf = useMemo(() => turnStepsOf(props.requests), [props.requests])
    useLayoutEffect(() => {
      const el = surfaceRef.current
      /* v8 ignore next 1 -- the surface renders unconditionally while the ribbon
         renders, so React attaches the ref before layout effects run. */
      if (el === null) return
      const cw = el.clientWidth
      /* v8 ignore next 1 -- the wrap renders unconditionally while the ribbon does. */
      const tip = (wrapRef.current ?? document.body).querySelector<HTMLElement>('.lc-chart-tip')
      if (tip === null) return
      const lw = tip.offsetWidth
      const half = Math.min(lw / 2, cw / 2)
      /* v8 ignore next 1 -- the tip renders only while a record is hovered, so the unwarmed arm cannot fire. */
      const cx = hoveredIdx >= 0 ? Math.min(Math.max(hoveredIdx / u * cw, half), cw - half) : 0
      const next = `translate(${Math.round(cx - lw / 2)}px, 0)`
      if (tip.style.transform !== next) tip.style.transform = next
    })

    const tipRows = hoveredIdx >= 0
      ? trendTipRows(kit, { granularity: props.granularity, stepsOf, delta, focus, durationOn }, requests[hoveredIdx])
      : null

    return (
      <div className="lc-chartrow">
        <div className="lc-axis">
          {delta ? (
            <>
              <span className="lc-axis-top">{fmtSigned(geo.maxUp)}</span>
              {q3Clear
                ? <span className="lc-axis-q3">{fmtSigned(Math.round(geo.maxUp - geo.span / 4))}</span>
                : null}
              <span className="lc-axis-mid" style={{ top: `${13 + geo.upPx}px` }}>{'0'}</span>
              {q1Clear
                ? <span className="lc-axis-q1">{fmtSigned(Math.round(geo.maxUp - 3 * geo.span / 4))}</span>
                : null}
              <span className="lc-axis-bot">{fmtSigned(-geo.maxDown)}</span>
            </>
          ) : (
            <>
              <span className="lc-axis-top">{kit.fmt(geo.maxTotal)}</span>
              <span className="lc-axis-q3">{kit.fmt(Math.round(geo.maxTotal * 3 / 4))}</span>
              <span className="lc-axis-mid">{kit.fmt(Math.round(geo.maxTotal / 2))}</span>
              <span className="lc-axis-q1">{kit.fmt(Math.round(geo.maxTotal / 4))}</span>
              <span className="lc-axis-bot">{'0'}</span>
            </>
          )}
        </div>
        <div className="lc-chart-wrap" ref={wrapRef}>
          <div className={'lc-chart-scroll lc-chart-fit' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}>
            <div
              className="lc-chart"
              ref={surfaceRef}
              // The CSS lights the key's bands in place, so neither an external legend hover nor the local band trace re-renders polygons.
              data-catdim={localCat ?? props.hoverCat ?? undefined}
              onMouseMove={onMove}
              onMouseLeave={onLeave}
              onClick={onClick}
            >
              <div className="lc-grid lc-grid-top" />
              {/* Dashed guides aligning the ribbon with the axis quarter marks; a delta mark that yielded to the zero label drops its
                  guide too. */}
              {(!delta || q3Clear) ? <div className="lc-grid lc-grid-q3" /> : null}
              {(!delta || q1Clear) ? <div className="lc-grid lc-grid-q1" /> : null}
              {!delta ? <div className="lc-grid lc-grid-mid" /> : null}
              <div className="lc-grid lc-grid-zero" style={delta ? { top: `${PLOT_TOP + geo.upPx}px` } : undefined} />
              {geo.bands.length > 0 || geo.durationRuns.length > 0 || geo.durationDots.length > 0 ? (
                <svg
                  className={'lc-duration lc-fit-svg' + RISE_CLASS}
                  viewBox={`0 0 ${u} ${CHART_H}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  {geo.bands.map((b, i) => (
                    <polygon
                      key={i}
                      data-cat={b.cat}
                      className="lc-cat-seg"
                      // Presentation attributes don't resolve var(); the fill rides inline style. The self-colored
                      // stroke seals the antialiasing seam against each neighbor.
                      style={{ fill: CAT_COLOR[b.cat], stroke: CAT_COLOR[b.cat] }}
                      points={b.points}
                    />
                  ))}
                  {geo.durationRuns.map((pts, i) => (
                    <Fragment key={i}>
                      <polyline className="lc-dur-halo" points={pts} />
                      <polyline points={pts} />
                    </Fragment>
                  ))}
                  {geo.durationDots.map((p, i) => (
                    <Fragment key={i}>
                      <circle className="lc-dur-halo" cx={p[0]} cy={p[1]} r={2} />
                      <circle cx={p[0]} cy={p[1]} r={1.2} />
                    </Fragment>
                  ))}
                </svg>
              ) : null}
              {/* A lit band keeps its original color along the whole ribbon, so its dim-and-light replaces the wash. */}
              {wash !== null && localCat === null ? (
                <>
                  <div className="lc-fit-wash" style={{ left: 0, width: wash.left, right: 'auto' }} />
                  <div className="lc-fit-wash" style={{ left: 'auto', width: wash.right, right: 0 }} />
                </>
              ) : null}
              {hoveredIdx >= 0 ? <div className="lc-fit-cursor" style={{ left: `${hoveredIdx / u * 100}%` }} /> : null}
              {selectedIdx >= 0 ? <div className="lc-fit-cursor lc-fit-pin" style={{ left: `${selectedIdx / u * 100}%` }} /> : null}
              <div className="lc-fit-layer">
                {props.markers.map((ev, i) => {
                  if (ev === undefined) return null
                  const at = eventAt(ev)
                  return (
                    <span
                      key={`marker-${i}`}
                      className="lc-bar-marker"
                      style={{ left: `${i / u * 100}%` }}
                      title={'✂ ' + (at !== null ? at + ' — ' : '') + eventLabel(ev)}
                    >{'✂'}</span>
                  )
                })}
                {flagRecords.map(idx => (
                  <span
                    key={`flag-${idx}`}
                    className="lc-trend-flag"
                    // The full-span pole hugs inside the pane's right edge: at left 100% its 1px falls past the clip,
                    // so it insets by its own width while the label still reads leftward.
                    style={{ left: idx === n - 1 ? 'calc(100% - 1px)' : `${idx / u * 100}%` }}
                    aria-hidden="true"
                  >
                    <span className="lc-trend-flag-label">{flagLabel(idx)}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="lc-turns" onMouseLeave={() => { props.onHoverTurn(null) }}>
              {groups.map((grp, gi) => {
                const on = props.activeTurn === grp.turn
                return (
                  <span
                    key={`turn-${gi}`}
                    className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                    style={{ flexGrow: grp.count, flexBasis: 0, background: TURN_FILLS[gi % TURN_FILLS.length] }}
                    title={`T${grp.turn}`}
                    onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                    onClick={() => { props.onPickTurn(grp.turn) }}
                  >{flagGroups.includes(gi) ? <span className="lc-turn-label">{`${grp.turn}`}</span> : null}</span>
                )
              })}
            </div>
          </div>
          {tipRows !== null ? (
            <div className="lc-chart-tip">{tipRows.map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
        {durationOn ? (
          <div className="lc-axis lc-axis-r">
            <span className="lc-axis-top">{kit.fmtDuration(geo.maxActiveMs)}</span>
            <span className="lc-axis-q3">{kit.fmtDuration(Math.round(geo.maxActiveMs * 3 / 4))}</span>
            <span className="lc-axis-mid">{kit.fmtDuration(Math.round(geo.maxActiveMs / 2))}</span>
            <span className="lc-axis-q1">{kit.fmtDuration(Math.round(geo.maxActiveMs / 4))}</span>
            <span className="lc-axis-bot">{'0'}</span>
          </div>
        ) : null}
      </div>
    )
  }
}
