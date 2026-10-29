/** Warm the active session's detail once its split head proves the channel exists, so the Context tab and `/context`
 * modal open on a landed payload. Warmed from the rendered conversation (not a global list listener), deduped per
 * session, and bounded: every pending timer is removed as soon as it fires. */

import { useEffect } from 'react'
import { asRecord } from './services'
import { detailStoreOf } from './timelineSource'

const WARM_DELAY_MS = 900

/** A page that scrolls through many sessions in one window still arms only a bounded number of timers. */
const MAX_PENDING = 32

interface PendingWarm {
  timer: ReturnType<typeof setTimeout>
  rev: number
}

const pending = new Map<string, PendingWarm>()

export function scheduleSessionWarm(sessionId: unknown, rev: number | null): void {
  if (typeof sessionId !== 'string' || sessionId === '' || rev === null || !Number.isFinite(rev) || rev < 0) return
  const known = pending.get(sessionId)
  if (known !== undefined) {
    // A streaming session bumps detailRev faster than the window; keep the original deadline and warm the LATEST
    // revision when it fires instead of resetting the timer forever.
    if (rev > known.rev) known.rev = rev
    return
  }
  const timer = setTimeout(() => {
    pending.delete(sessionId)
    detailStoreOf(sessionId).warm(rev)
  }, WARM_DELAY_MS)
  pending.set(sessionId, { timer, rev })
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value as string
    const entry = pending.get(oldest) as PendingWarm
    clearTimeout(entry.timer)
    pending.delete(oldest)
  }
}

export function cancelSessionWarm(sessionId: string): void {
  const entry = pending.get(sessionId)
  if (entry === undefined) return
  clearTimeout(entry.timer)
  pending.delete(sessionId)
}

/** Reset the page-scope schedule (tests and a session-binding teardown). */
export function resetSessionWarm(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
}

/** Hook form for the always-mounted input overlay: the session id and its split head drive the schedule. */
export function useSessionDetailWarm(sessionId: unknown, useProjection: unknown): void {
  const head = typeof useProjection === 'function'
    ? (useProjection as (key: string) => unknown)('contextTimeline')
    : undefined
  const rev = asRecord(head)?.detailRev
  const warmRev = typeof rev === 'number' && Number.isFinite(rev) && rev >= 0 ? rev : null
  useEffect(() => {
    scheduleSessionWarm(sessionId, warmRev)
  }, [sessionId, warmRev])
  useEffect(() => () => {
    if (typeof sessionId === 'string') cancelSessionWarm(sessionId)
  }, [sessionId])
}
