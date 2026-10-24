import { useEffect, useState, type RefObject } from 'react'

export const ROW_WINDOW_OVERSCAN = 8

export interface RowRange {
  from: number
  to: number
}

export function rowWindowFor(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  if (count <= 0 || rowHeight <= 0 || viewport <= 0) return { from: 0, to: Math.max(0, count - 1) }
  const from = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan))
  const to = Math.min(count - 1, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)
  return { from, to: Math.max(from, to) }
}

/** Renders only the rows a fixed-row-height scroller shows: full height via caller-owned spacers, every readout in the
 * model, and the window shifts only across row boundaries. Disabled/unmeasured lists render in full. */
export function useRowWindow(
  ref: RefObject<HTMLElement | null>,
  count: number,
  rowHeight: number,
  enabled: boolean,
  overscan: number = ROW_WINDOW_OVERSCAN,
): RowRange {
  const full: RowRange = { from: 0, to: Math.max(0, count - 1) }
  const [range, setRange] = useState<RowRange>(full)
  useEffect(() => {
    const el = ref.current
    if (el === null || !enabled || el.clientHeight <= 0) {
      setRange(current => (current.from === 0 && current.to === Math.max(0, count - 1) ? current : full))
      return
    }
    let frame = 0
    const update = (): void => {
      frame = 0
      const next = rowWindowFor(el.scrollTop, el.clientHeight, rowHeight, count, overscan)
      setRange(current => (current.from === next.from && current.to === next.to ? current : next))
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update)
    }
    el.addEventListener('scroll', schedule, { passive: true })
    /* v8 ignore start -- jsdom has neither a layout nor ResizeObserver; the live page covers a pane resize. */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
    observer?.observe(el)
    /* v8 ignore stop */
    update()
    return () => {
      el.removeEventListener('scroll', schedule)
      if (frame !== 0) cancelAnimationFrame(frame)
      /* v8 ignore next -- the observer only exists where ResizeObserver is available (not jsdom). */
      observer?.disconnect()
    }
  }, [ref, count, rowHeight, enabled, overscan, full.from, full.to])
  return enabled ? range : full
}
