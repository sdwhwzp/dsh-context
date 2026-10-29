/** One family derivation (list subscription, cold-head backfill, forest, team projection) shared by every
 * Fleet panel and the right Sidebar's inline mount; the detail reads run behind a page-scope ledger. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHeads } from './agentHeads'
import { useSessionsSnapshot } from './agentHeads'
import { agentForestOf, sessionTitlesOf, sessionsFaceOf, type AgentForest, type AgentSelfStats } from './agentTree'
import { FleetDetailCache } from './fleetDetail'
import { lruTrim } from './lru'
import { teamOf, type FleetTeam } from './fleetTeam'
import type { ClientCtx } from './services'
import { asRecord } from './services'
import type { ContextTimeline, FleetDetail } from '../shared/types'

export interface FleetModel {
  forest: AgentForest | null
  team: FleetTeam | null
  /** Display titles for every session row, including parties outside the viewed family. */
  titles: ReadonlyMap<string, string>
}

/** The family's `agentTeam` projection: DFS starts at the root (the team lives on the lead). */
export function teamOfSnapshot(snapshot: unknown, forest: AgentForest | null): FleetTeam | null {
  if (forest === null) return null
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null) return null
  for (const n of forest.nodes) {
    const row = asRecord(byId[n.id])
    const team = teamOf(asRecord(row?.projectionValues)?.agentTeam)
    if (team !== null) return team
  }
  return null
}

/** The family model behind the Agent network card and the Fleet tab's panels; `active` gates subscriptions. */
export function useFleetModel(
  ctx: ClientCtx,
  heads: AgentHeads,
  sessionId: string | undefined,
  self: AgentSelfStats | undefined,
  active: boolean,
  coalesceMs = 0,
): FleetModel {
  // Resolved lazily at mount: the outward sessions service belongs to the client runtime's composition.
  const face = useMemo(() => (active ? sessionsFaceOf(ctx) : null), [ctx, active])
  const snapshot = useSessionsSnapshot(face, coalesceMs)

  // Discover the direct-child catalog once per session so catalog-derived children join the list rows.
  useEffect(() => {
    if (face === null || typeof sessionId !== 'string' || sessionId === '') return
    if (typeof face.refreshSubagents !== 'function') return
    face.refreshSubagents(sessionId).catch(() => {})
  }, [face, sessionId])

  // Landed cold-relative heads re-fold the forest with the row's missing `contextTimeline` injected.
  const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())

  const forest = useMemo(
    () => agentForestOf(snapshot, sessionId, self, landed),
    [snapshot, sessionId, self, landed],
  )

  // Nodes with no composition fetch their slim head off the shared page-scope cache; the current node is
  // excluded. A remount resets state but not the cache, so a cached read must REPLAY.
  useEffect(() => {
    if (forest === null) return
    const attach = (pending: Promise<ContextTimeline | null>, id: string): void => {
      void pending.then((head) => {
        if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
      }).catch(() => {})
    }
    for (const n of forest.nodes) {
      if (n.isCurrent || (n.head !== null && n.head.parts.length > 0)) continue
      attach(heads.headOf(n.id), n.id)
    }
  }, [forest, heads])

  const team = useMemo(() => teamOfSnapshot(snapshot, forest), [snapshot, forest])
  const titles = useMemo(() => sessionTitlesOf(snapshot), [snapshot])

  return { forest, team, titles }
}

export interface FleetDetailState {
  /** Landed reads keyed by session id; a null detail means the route served nothing (absent or failed). */
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>
  fullLanded: ReadonlyMap<string, FleetDetail | null>
  pending: ReadonlySet<string>
  fullPending: ReadonlySet<string>
  request(id: string, updatedAt: number): void
  requestFull(id: string): void
}

/** The page-scope ledger every mount shares (the agentHeads pattern): a remount replays settled reads. */
const sharedCache = new FleetDetailCache()
/** Full details carry whole reports; only the most recently opened cards keep their payload mounted. */
const FULL_STATE_MAX = 8

export interface FleetDetailOptions {
  /** Maximum excerpt reads in flight; a family scan fills progressively instead of bursting the route. */
  concurrency?: number
  /** A landed card's newer stamp waits this long (trailing), so a running agent's pushes do not refetch per event. */
  refreshDelayMs?: number
}

export function useFleetDetails(cache: FleetDetailCache = sharedCache, options: FleetDetailOptions = {}): FleetDetailState {
  const maxInflight = options.concurrency ?? Number.POSITIVE_INFINITY
  const refreshDelay = options.refreshDelayMs ?? 0
  const [landed, setLanded] = useState<ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>>(new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  /** Requested stamps, for synchronous dedupe; the cache dedupes the network read too. */
  const requested = useRef(new Map<string, number>())
  const mounted = useRef(true)
  const active = useRef(0)
  const queue = useRef<Array<{ id: string; stamp: number }>>([])
  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const drain = (): void => {
    while (active.current < maxInflight && queue.current.length > 0) {
      const task = queue.current.shift() as { id: string; stamp: number }
      /* v8 ignore next 1 -- enqueue replaces a queued stamp, so a superseded queue entry cannot reach here. */
      if (requested.current.get(task.id) !== task.stamp) continue
      active.current++
      void cache.fetch(task.id, task.stamp).then((detail) => {
        // A newer read may have claimed the session while this one was in flight; only the latest stamp may land.
        if (!mounted.current || requested.current.get(task.id) !== task.stamp) return
        setLanded(prev => new Map(prev).set(task.id, { detail, updatedAt: task.stamp }))
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }).catch(() => {
        // A failed read is a settled absence: drop its pending mark so the card's note is not a permanent skeleton.
        /* v8 ignore next 1 -- a rejected read is dropped only after unmount or a newer stamp, like the success arm. */
        if (!mounted.current || requested.current.get(task.id) !== task.stamp) return
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }).finally(() => {
        active.current--
        drain()
      })
    }
  }

  const enqueue = (id: string, stamp: number, silent = false): void => {
    if (!silent) setPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    const at = queue.current.findIndex(task => task.id === id)
    if (at >= 0) {
      queue.current[at] = { id, stamp }
    } else {
      queue.current.push({ id, stamp })
    }
    drain()
  }

  const request = (id: string, updatedAt: number): void => {
    const known = requested.current.get(id)
    if (known !== undefined && known >= updatedAt) return
    requested.current.set(id, updatedAt)
    if (refreshDelay > 0 && landed.has(id)) {
      const armed = refreshTimers.current.get(id)
      if (armed !== undefined) clearTimeout(armed)
      refreshTimers.current.set(id, setTimeout(() => {
        refreshTimers.current.delete(id)
        /* v8 ignore next 1 -- the cleanup clears every armed timer on unmount. */
        if (!mounted.current) return
        const target = requested.current.get(id)
        /* v8 ignore next 1 -- the timer is armed only after requested.set(id, stamp), so the target exists. */
        if (target !== undefined) enqueue(id, target, true)
      }, refreshDelay))
      return
    }
    enqueue(id, updatedAt)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queue.current = []
      for (const timer of refreshTimers.current.values()) clearTimeout(timer)
      refreshTimers.current.clear()
    }
  }, [])

  // Full reads ride their own state maps: an on-demand read must not make the excerpt's landed entries disagree. The
  // stamp map lets an opened card follow later activity — a newer excerpt stamp refetches the full text once.
  const [fullLanded, setFullLanded] = useState<ReadonlyMap<string, FleetDetail | null>>(new Map())
  const [fullPending, setFullPending] = useState<ReadonlySet<string>>(new Set())
  const fullRequested = useRef(new Map<string, number>())
  // The landed keys survive a stale render closure, so a second click from the same paint cannot refetch; trimming the
  // state map also releases them for a replay.
  const fullKnown = useRef<ReadonlySet<string>>(new Set())
  const fullInFlight = useRef<Set<string>>(new Set())

  const requestFull = (id: string): void => {
    const stamp = requested.current.get(id) ?? 0
    const known = fullRequested.current.get(id)
    // An evicted state entry must be replayed from the cache; the stamp map alone would suppress the reread.
    if (known !== undefined && known >= stamp && (fullKnown.current.has(id) || fullInFlight.current.has(id))) return
    fullRequested.current.set(id, stamp)
    fullInFlight.current.add(id)
    setFullPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    void cache.fetch(id, stamp, true).then((detail) => {
      if (!mounted.current || fullRequested.current.get(id) !== stamp) return
      fullInFlight.current.delete(id)
      setFullLanded((prev) => {
        const next = new Map(prev)
        next.delete(id)
        next.set(id, detail)
        lruTrim(next, FULL_STATE_MAX)
        fullKnown.current = new Set(next.keys())
        return next
      })
      setFullPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })
  }

  return { landed, fullLanded, pending, fullPending, request, requestFull }
}
