/** The command card's incremental history fill: reconciles the projection's newest slice with the paged complete log.
 * The served records are folded into a durable map on every push, so a later trim cannot drop a record the panel
 * already showed; the pager then walks backwards to the log's start. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Command } from '../commands'
import type { CommandPageFetcher } from '../commandPages'

/** The paused gap between page reads: the initial slice paints first, the older history fills in without a burst. */
const PAGE_PAUSE_MS = 30

type FillState =
  | { status: 'idle' }
  | { status: 'done' }
  | { status: 'loading'; cursor: number; total?: number }
  | { status: 'failed'; cursor: number }

export interface CommandLog {
  /** The complete known log: served records overwrite their paged copies, and a record the projection later trims
   * away stays in the map. */
  records: Command[]
  status: FillState['status']
  total?: number
  retry: () => void
}

export type CommandFill = Pick<CommandLog, 'status' | 'total'> & { retry?: () => void }

/** The merge for a served push: a trimmed log keeps every record it ever served, and an updated copy replaces its
 * older one. An untrimmed log never reaches this — it serves the complete list, so the hook returns it as-is. */
function knownWithServed(prev: ReadonlyMap<number, Command>, served: readonly Command[]): ReadonlyMap<number, Command> {
  let next: Map<number, Command> | undefined
  for (const rec of served) {
    if (prev.get(rec.seq) === rec) continue
    next ??= new Map(prev)
    next.set(rec.seq, rec)
  }
  return next ?? prev
}

/** A paged record joins only when its seq is unknown: a served copy (or a later page's) always wins. */
function knownWithPage(prev: ReadonlyMap<number, Command>, incoming: readonly Command[]): ReadonlyMap<number, Command> {
  let next: Map<number, Command> | undefined
  for (const rec of incoming) {
    if (prev.has(rec.seq)) continue
    next ??= new Map(prev)
    next.set(rec.seq, rec)
  }
  return next ?? prev
}

export function useCommandLog(
  served: readonly Command[],
  floor: number | undefined,
  fetchOlder: CommandPageFetcher | undefined,
): CommandLog {
  const [known, setKnown] = useState<ReadonlyMap<number, Command>>(() => new Map())
  const [fill, setFill] = useState<FillState>({ status: 'idle' })
  // The retry target: the failed page's cursor, so a resumed fill continues where it stopped.
  const cursorTarget = useRef(0)
  useEffect(() => {
    if (served.length === 0 || floor === undefined) return
    setKnown(prev => knownWithServed(prev, served))
  }, [served, floor])
  const records = useMemo<Command[]>(() => {
    if (floor === undefined || known.size === 0) return served as Command[]
    const merged = new Map(known)
    for (const rec of served) merged.set(rec.seq, rec)
    return [...merged.values()]
  }, [served, known, floor])
  useEffect(() => {
    if (fill.status !== 'idle' || floor === undefined || served.length === 0 || fetchOlder === undefined) return
    const cursor = floor + 1
    cursorTarget.current = cursor
    setFill({ status: 'loading', cursor })
  }, [fill.status, floor, served.length, fetchOlder])
  useEffect(() => {
    if (fill.status !== 'loading' || fetchOlder !== undefined) return
    // The channel went away mid-fill (the view fell back to the inline generation): stop the fill as a failure so the
    // coverage note and its retry replace a note that would otherwise never settle.
    setFill({ status: 'failed', cursor: fill.cursor })
  }, [fill, fetchOlder])
  useEffect(() => {
    if (fill.status !== 'loading' || fetchOlder === undefined) return
    const cursor = fill.cursor
    let live = true
    const timer = setTimeout(() => {
      void fetchOlder(cursor).then(
        (result) => {
          if (!live) return
          if (result === null) {
            setFill({ status: 'failed', cursor })
            return
          }
          if (result.commands.length > 0) setKnown(prev => knownWithPage(prev, result.commands))
          let oldest = cursor
          for (const rec of result.commands) if (rec.seq < oldest) oldest = rec.seq
          if (result.atStart) {
            setFill({ status: 'done' })
            return
          }
          if (oldest >= cursor) {
            setFill({ status: 'failed', cursor })
            return
          }
          cursorTarget.current = oldest
          setFill({ status: 'loading', cursor: oldest, total: result.total })
        },
        () => { if (live) setFill({ status: 'failed', cursor }) },
      )
    }, PAGE_PAUSE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [fill, fetchOlder])
  const retry = useCallback(() => {
    setFill({ status: 'loading', cursor: cursorTarget.current })
  }, [])
  return {
    records,
    status: fill.status,
    ...(fill.status === 'loading' && fill.total !== undefined ? { total: fill.total } : {}),
    retry,
  }
}
