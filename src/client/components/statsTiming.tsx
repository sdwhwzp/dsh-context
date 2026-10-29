import { useState, type ReactElement } from 'react'
import type { TimingSpan, TimingTotals } from '../../shared/types'
import type { ViewKit } from '../viewkit'
import { IconClock } from '../primitives'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import { makeTimingStrip, TIMING_COLOR } from './timingStrip'
import type { DonutProps, DonutSegment } from './donut'

interface Slice {
  key: string
  color: string
  label: string
  /** TRUE duration (the row prints this; the ring clamps it into its window). */
  ms: number
  times?: string
}

const COLOR = TIMING_COLOR

/** Decode throughput, formatted exactly as the harness's own session-stats seat: whole tokens from ten up, one decimal below. */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

export interface StatsTimingProps {
  timing: TimingTotals | null
  /** Per-step time slices; absent on the overview aggregate card and on rows folded before the collection existed. */
  spans?: TimingSpan[]
  locale?: string
}

export function makeStatsTiming(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: StatsTimingProps) => ReactElement {
  const { t, fmt, fmtDuration, fmtShare } = kit
  const TimingStrip = makeTimingStrip(kit)
  return function StatsTiming(props: StatsTimingProps): ReactElement {
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const timing = props.timing
    const wall = timing !== null && Number.isFinite(timing.wallMs) && timing.wallMs > 0 ? timing.wallMs : 0
    // Host-paired output tokens over decode windows, exactly as the harness session-stats fold does; an unreadable pairing renders no
    // figure.
    const tps = timing !== null
      && typeof timing.speedMs === 'number' && Number.isFinite(timing.speedMs) && timing.speedMs > 0
      && typeof timing.speedTokens === 'number' && Number.isFinite(timing.speedTokens) && timing.speedTokens >= 0
      ? formatTokensPerSecond(timing.speedTokens / (timing.speedMs / 1_000))
      : null
    let segments: DonutSegment[] = []
    let rows: SliceRow[] = []
    if (timing !== null && (wall > 0 || timing.calls > 0 || timing.toolCalls > 0)) {
      // Model slices run from the step's start to its assistant message: TTFT to the first token, generation from there.
      const callTimes = t('timing.callTimes', { n: fmt(timing.calls) })
      const modelSlices: Slice[] = [
        { key: 'ttft', color: COLOR.ttft, label: t('timing.ttft'), ms: timing.ttftMs, times: callTimes },
      ]
      // The generation window expands into decode buckets only when the buckets carry time (absent reads 0).
      const blockTimes = (blocks?: number): string | undefined =>
        blocks !== undefined && blocks > 0 ? t('timing.blockTimes', { n: fmt(blocks) }) : undefined
      const buckets: [key: string, color: string, label: string, ms: number, times?: string][] = [
        ['reasoning', COLOR.reasoning, t('timing.reasoning'), timing.reasoningMs ?? 0, blockTimes(timing.reasoningBlocks)],
        ['text', COLOR.text, t('timing.text'), timing.textMs ?? 0, blockTimes(timing.textBlocks)],
        ['toolarg', COLOR.toolarg, t('timing.toolArgs'), timing.toolArgMs ?? 0, blockTimes(timing.toolArgBlocks)],
      ]
      const split = buckets.some(([, , , ms]) => ms > 0)
      if (split) {
        for (const [key, color, label, ms, times] of buckets) {
          modelSlices.push({ key, color, label, ms, ...(times !== undefined ? { times } : {}) })
        }
      } else {
        modelSlices.push({ key: 'gen', color: COLOR.reasoning, label: t('timing.gen'), ms: timing.genMs })
      }
      // Ring windows: TTFT, then generation, then tools with what is left; the residue is overhead. Every window clamps
      // into the space its predecessors leave, so a hostile over-long slice never pushes the ring past the wall.
      const ttftRing = Math.min(timing.ttftMs, wall)
      const genRing = Math.max(0, Math.min(timing.genMs, wall - ttftRing))
      const modelRings: number[] = [ttftRing]
      let used = ttftRing
      const genEnd = ttftRing + genRing
      for (const slice of modelSlices.slice(1)) {
        const take = Math.max(0, Math.min(slice.ms, genEnd - used))
        modelRings.push(take)
        used += take
      }
      const toolRing = Math.max(0, Math.min(timing.toolsMs, wall - ttftRing - genRing))
      const other = Math.max(0, wall - ttftRing - genRing - toolRing)
      const share = (ms: number): number => (wall > 0 ? ms / wall : 0)
      // The secondary line leads with the duration and qualifies it with the tally; a zero-duration slice keeps the tally.
      const countOf = (ms: number, times?: string): string => {
        const dur = fmtDuration(ms)
        if (times === undefined) return dur
        return ms > 0 ? `${dur} · ${times}` : times
      }
      const modelSegments = modelSlices.map((slice, index) => ({
        key: slice.key, color: slice.color, value: share(modelRings[index]),
      }))
      const toolSlice: Slice = {
        key: 'tools',
        color: COLOR.tools,
        label: t('timing.tools'),
        ms: timing.toolsMs,
        times: t('timing.toolTimes', { n: fmt(timing.toolCalls) }),
      }
      const otherSlice: Slice = { key: 'other', color: COLOR.other, label: t('timing.other'), ms: other }
      segments = [
        ...modelSegments,
        { key: 'tools', color: COLOR.tools, value: share(toolRing) },
        { key: 'other', color: COLOR.other, value: share(other) },
      ]
      const toRow = (slice: Slice): SliceRow => ({
        key: slice.key,
        color: slice.color,
        label: slice.label,
        dim: slice.ms === 0,
        pct: fmtShare(slice.ms, wall),
        count: countOf(slice.ms, slice.times),
      })
      // A slice that never happened stays hidden (a "0.0%" row carrying the tally reads as "many calls, no time").
      // The residual overhead row is the exception: its transient zero clamp would resize the card at every step boundary.
      const sliceRows = [
        ...modelSlices.map(toRow),
        toRow(toolSlice),
        toRow(otherSlice),
      ]
      rows = sliceRows.some(row => !row.dim)
        ? sliceRows.filter(row => !row.dim || row.key === otherSlice.key)
        : []
    }
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconClock size={14} />
            {t('timing.title')}
          </span>
          {tps !== null && (
            <span className="lc-card-rate" title={t('timing.tpsTip')}>{t('timing.tps', { tps })}</span>
          )}
        </div>
        {rows.length === 0
          ? <div className="lc-empty">{t('timing.empty')}</div>
          : (
            <>
              <div
                className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap"
              >
                <Donut
                  segments={segments}
                  size={96}
                  centerTop={wall > 0 ? fmtDuration(wall) : '—'}
                  centerSub={t('timing.total')}
                  hoverKey={hoverKey}
                  onHoverKey={setHoverKey}
                />
                <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
              </div>
              {/* The strip joins the hover link: a span hover lights every span of its KIND plus the donut arc and legend row. */}
              {props.spans !== undefined && props.spans.length > 0
                ? <TimingStrip spans={props.spans} hoverKey={hoverKey} onHoverKey={setHoverKey} locale={props.locale} />
                : null}
            </>
          )}
      </div>
    )
  }
}
