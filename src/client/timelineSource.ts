/** The timeline source behind the Context tab and /context modal: reconciles the INLINE generation (the
 * collections ride the value) with the SPLIT one (a slim head plus `/api/dsh-context/detail`). */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import { DETAIL_ROUTE } from './apiRoutes'
import type { SessionStandardProps } from './services'
import { asRecord, collectionsOf, projectionOf, timelineOf } from './services'

/** A missing or NaN revision rejects the whole payload, so the caller shows its retryable note, never half-merged data. */
export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  // A malformed head drops out rather than rejecting the payload.
  const head = timelineOf(data.head)
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    ...collectionsOf(data),
  }
}

export function makeDetailFetcher(
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) throw new Error(`dsh-context: detail route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-context: detail read failed')
    if (r.value === null) return null
    const detail = detailOf(r.value)
    if (detail === null) throw new Error('dsh-context: detail read malformed')
    return detail
  }
}

/** The store's snapshot, rebuilt on every transition and identity-gated for `useSyncExternalStore`. */
export interface DetailSnap {
  /** The newest accepted detail, kept while a refetch is in flight so the cards never flicker back to loading. */
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

const DETAIL_DEBOUNCE_MS = 300

/** One frame for the head/skeleton to paint, then the first read starts without the trailing window. */
const EAGER_DELAY_MS = 16

/** One bounded catch-up read when the host serves a current revision just behind the pushed head. */
const CATCH_UP_MS = 1_000

/** One session's detail ledger; exported for tests, reached by the app through `detailStoreOf`. */
export class DetailStore {
  private detail: ContextTimelineDetail | null = null
  /** The revision of `detail` (latest-wins cursor); -1 before the first landing. */
  private acceptedRev = -1
  private wantedRev = -1
  /** The head rev the in-flight (or scheduled) read targets — the refold exception's acceptance key. */
  private targetRev = -1
  /** The head rev seen last; a DECREASE means the host refolded and revisions restarted. */
  private lastHeadRev = -1
  private generation = 0
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** No view holds this store: it keeps its cached payload so a re-open renders instantly but arms no read. */
  private parked = false
  /** Approximate live bytes of `detail`, so the page cache can hold a byte budget rather than a payload count. */
  private bytes = 0
  /** A warm-up read with no view attached: it must never arm an endless background retry. */
  private background = false
  private catchUp: ReturnType<typeof setTimeout> | null = null
  /** The head target already given one catch-up read; reset by a newer head or a reset. */
  private catchUpTarget = -1
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: (() => Promise<ContextTimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
    /** The production view reads its first frame at once; later revisions still coalesce on the trailing window. */
    private readonly eagerFirst: boolean = false,
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    if (this.parked) {
      this.parked = false
      // Resume with nothing cached: clear the ledger and the old backoff so the mount's request reads again.
      if (this.detail === null) {
        this.resetLedger()
        this.failures = 0
      }
    }
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.park()
    }
  }

  readonly getSnapshot = (): DetailSnap => this.snap

  /** Schedule the trailing-edge read when the head outruns the served detail; a DECREASE means the host refolded, so the ledger resets. */
  request(rev: number): void {
    this.background = false
    if (rev < this.lastHeadRev) this.resetLedger()
    // An explicit read (or a newer head) supersedes a pending catch-up.
    if (rev >= this.lastHeadRev) {
      this.clearCatchUp()
      this.catchUpTarget = -1
    }
    this.lastHeadRev = rev
    if (rev <= this.acceptedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  /** A background read for a session the reader has not opened yet: the tab/modal then lands on a warm payload. */
  warm(rev = 0): void {
    this.background = this.listeners.size === 0
    if (rev > this.lastHeadRev) this.lastHeadRev = rev
    if (rev > this.wantedRev) this.wantedRev = rev
    if (this.inFlight) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.parked = false
    if (this.detail === null || rev > this.acceptedRev) void this.fire()
  }

  get byteSize(): number {
    return this.bytes
  }

  readonly retry = (): void => {
    this.background = false
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private resetLedger(): void {
    this.clearCatchUp()
    this.catchUpTarget = -1
    this.generation++
    this.acceptedRev = -1
    this.wantedRev = -1
    this.detail = null
    this.bytes = 0
    this.failed = false
    // Drop the snapshot's own payload reference too: it is the second place a released detail could stay reachable from.
    this.snap = EMPTY_SNAP
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  get hasPayload(): boolean {
    return this.detail !== null
  }

  /** Demote the store: drop its cached payload and pending work, once the page cache exceeds its bound. */
  release(): void {
    this.clearCatchUp()
    this.catchUpTarget = -1
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.resetLedger()
    this.failures = 0
  }

  private park(): void {
    this.parked = true
    this.clearCatchUp()
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit()
  }

  private clearCatchUp(): void {
    if (this.catchUp !== null) {
      clearTimeout(this.catchUp)
      this.catchUp = null
    }
  }

  private schedule(): void {
    // Nobody reads a parked store's answer, so never arm one.
    if (this.parked || this.timer !== null) return
    if (this.eagerFirst && this.detail === null && !this.failed) {
      // Off the render/commit turn: the head's loading frame paints, then the first read starts without the old
      // 300ms trailing window.
      this.timer = setTimeout(() => {
        this.timer = null
        void this.fire()
      }, EAGER_DELAY_MS)
      this.emit()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private async fire(): Promise<void> {
    // A trailing timer fired while an earlier read is in flight; that read's settle re-arms.
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      // No session id to read for: the typed failure arms the cards' note.
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.targetRev = this.wantedRev
    const background = this.background
    const generation = this.generation
    this.emit()
    try {
      const d = await this.fetcher()
      if (generation !== this.generation) return
      if (d !== null) {
        if (d.rev >= this.acceptedRev || d.rev === this.targetRev) {
          this.detail = d
          this.bytes = detailBytesOf(d)
          this.acceptedRev = d.rev
        }
        // A current revision behind the head is the host's truth; do not chase it every window. A genuinely stale
        // answer (behind the accepted rev) keeps its target so the trailing read can converge.
        if (d.rev >= this.acceptedRev && d.rev < this.targetRev) {
          this.wantedRev = d.rev
          // One bounded re-read lets an idle session catch up when the host lagged for a single cut; a newer head
          // resets the one-shot, and a second short answer is accepted rather than polled.
          if (this.listeners.size > 0 && this.catchUpTarget !== this.targetRev) {
            this.catchUpTarget = this.targetRev
            this.clearCatchUp()
            const target = this.targetRev
            this.catchUp = setTimeout(() => {
              this.catchUp = null
              if (this.detail === null || this.acceptedRev < target) {
                this.wantedRev = target
                void this.fire()
              }
            }, CATCH_UP_MS)
          }
        }
        this.failures = 0
        this.failed = false
      } else {
        // Absent (the session left the live set): keep the last detail; arm the note only when nothing is showable.
        this.wantedRev = this.acceptedRev
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      if (generation === this.generation) {
        this.failed = this.detail === null
        this.failures++
      }
    } finally {
      this.inFlight = false
      // A failed warm-up must not suppress the view's own first request: reopen the target so the tab retries.
      if (this.failed && background && this.listeners.size === 0) this.wantedRev = this.acceptedRev
      // A warm-up with no reader never loops in the background; a mounted view (or an explicit request) retries.
      if (this.wantedRev > this.acceptedRev && (this.listeners.size > 0 || !background)) this.schedule()
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight
    const next: DetailSnap = { detail: this.detail, failed: this.failed, pending }
    if (next.detail === this.snap.detail && next.failed === this.snap.failed && next.pending === this.snap.pending) return
    this.snap = next
    for (const fn of this.listeners) fn()
  }
}

/** Cap on sessions keeping a fetched detail payload cached: one measures ~194KB of JSON (~300KB live heap) on a
 * page-lifetime map, so older idle stores are demoted and read again. */
const DETAIL_STORES_MAX = 8

/** A monster session's detail is ~1MB of JSON (~1.5MB live); the byte budget keeps eight small sessions while stopping
 * eight large ones from pinning tens of MB. */
const DETAIL_BYTES_MAX = 6 * 1024 * 1024

/** Rough live heap per collection row; only the relative weight matters, and over-counting is the safe direction. */
export function detailBytesOf(detail: ContextTimelineDetail): number {
  return 2048
    + detail.requests.length * 180
    + detail.events.length * 120
    + detail.nodes.length * 160
    + detail.archive.length * 160
    + (detail.fileOps?.length ?? 0) * 220
    + (detail.commands?.length ?? 0) * 420
    + (detail.spans?.length ?? 0) * 60
}

/** Cap on the page-lifetime store map itself: a payload-free store is small, but a page that touches hundreds of
 * sessions (a Fleet scan, the modal across a long list) would otherwise pin one fetcher closure and listener set
 * per id forever. */
const DETAIL_STORE_ENTRIES_MAX = 64

/** Page-lifetime per-session stores (the tab and the modal share one). */
const stores = new Map<string, DetailStore>()

function payloadHolders(): number {
  let held = 0
  for (const store of stores.values()) if (store.hasPayload) held++
  return held
}

function payloadBytes(): number {
  let bytes = 0
  for (const store of stores.values()) bytes += store.byteSize
  return bytes
}

export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  const store = known ?? new DetailStore(makeDetailFetcher(sessionId), DETAIL_DEBOUNCE_MS, true)
  // Re-inserting moves the entry to the map's newest end, so demotion targets the least recently opened session.
  if (known !== undefined) stores.delete(sessionId)
  stores.set(sessionId, store)
  // A store without a payload is about to fetch one, so it counts as one more; an active store is never demoted.
  let excess = payloadHolders() - DETAIL_STORES_MAX + (store.hasPayload ? 0 : 1)
  let bytes = payloadBytes()
  for (const candidate of stores.values()) {
    if (excess <= 0 && bytes <= DETAIL_BYTES_MAX) break
    if (candidate === store || candidate.active || !candidate.hasPayload) continue
    bytes -= candidate.byteSize
    candidate.release()
    excess--
  }
  // Trim the map's least recently opened entries, never an ACTIVE store: a mounted view holds its store by closure,
  // but dropping it would fork the session's ledger (the next mount would build a second one) and double its reads.
  if (stores.size > DETAIL_STORE_ENTRIES_MAX) {
    for (const id of stores.keys()) {
      if (stores.size <= DETAIL_STORE_ENTRIES_MAX) break
      if (id === sessionId) continue
      const candidate = stores.get(id)
      if (candidate === undefined || candidate === store || candidate.active) continue
      stores.delete(id)
    }
  }
  return store
}

export function resetTimelineDetailStores(): void {
  stores.clear()
}

export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

export interface TimelineSource {
  /** The value the cards render: the inline generation's value, or the slim head merged with the fetched detail collections. */
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}

/** Hook-order safe: every hook runs unconditionally; the branches below only shape the returned record. */
export function useTimelineSource(props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  // The split marker: a slim head carries `detailRev`; null (inline value, gate fallback, corrupt payload) means no channel.
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  // No pushed value yet: the source opens the channel itself (rev 0) rather than waiting on a push.
  const cold = head === null
  // No session address, no channel: never create a store (and never arm its inevitable failed read).
  const store = useMemo(
    () => (sessionId !== '' && (slim || cold) ? detailStoreOf(sessionId) : null),
    [sessionId, slim, cold],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    if (store !== null) store.request(headRev ?? 0)
  }, [store, headRev])

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    const retry = store !== null ? store.retry : noopRetry
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: noopRetry }
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      // Nothing renderable yet: the retryable failure, never a dead spinner.
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry }
    }
    if (detail === null) {
      // The head's counters render while the first read is in flight (the failure note rides beside).
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry }
    }
    const data: ContextTimeline = {
      ...base,
      requests: detail.requests,
      events: detail.events,
      nodes: detail.nodes,
      droppedNodes: detail.droppedNodes,
      archive: detail.archive,
      // Slim heads serve no floors; the detail's pair lands whole here.
      ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
      ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
      ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
      ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
      ...(detail.commands !== undefined ? { commands: detail.commands } : {}),
      ...(detail.commandsFloor !== undefined ? { commandsFloor: detail.commandsFloor } : {}),
      ...(detail.commandStats !== undefined ? { commandStats: detail.commandStats } : {}),
      ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
    }
    return { data, detailState: 'ready', retryDetail: retry }
  }, [head, slim, store, snap])
}
