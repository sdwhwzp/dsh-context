/** One family derivation (list subscription, cold-head backfill, forest, team projection) shared by every
 * Fleet panel and the right Sidebar's inline mount; the detail reads run behind a page-scope ledger. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHeads } from './agentHeads'
import { useSessionsSnapshot } from './agentHeads'
import { agentForestOf, sessionsFaceOf, type AgentForest, type AgentNode, type AgentSelfStats } from './agentTree'
import { FleetDetailCache } from './fleetDetail'
import { teamOf, type FleetTeam } from './fleetTeam'
import type { ClientCtx } from './services'
import { asRecord } from './services'
import type { ContextTimeline, FleetDetail } from '../shared/types'

export interface FleetModel {
  forest: AgentForest | null
  team: FleetTeam | null
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
): FleetModel {
  // Resolved lazily at mount: the outward sessions service belongs to the client runtime's composition.
  const face = useMemo(() => (active ? sessionsFaceOf(ctx) : null), [ctx, active])
  const snapshot = useSessionsSnapshot(face)

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

  return { forest, team }
}

export interface FleetDetailState {
  /** Landed reads keyed by session id; a null detail means the route served nothing (absent or failed). */
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>
  fullLanded: ReadonlyMap<string, FleetDetail | null>
  pending: ReadonlySet<string>
  fullPending: ReadonlySet<string>
  /** Sessions the comms panel's scan/refresh claimed — inspector reads alone never join this set. */
  scanned: ReadonlySet<string>
  request(id: string, updatedAt: number): void
  requestFull(id: string): void
  scan(nodes: readonly AgentNode[]): void
  refresh(nodes: readonly AgentNode[]): void
}

export function commsStaleOf(
  nodes: readonly AgentNode[],
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>,
): boolean {
  for (const n of nodes) {
    const entry = landed.get(n.id)
    if (entry !== undefined && n.updatedAt > entry.updatedAt) return true
  }
  return false
}

/** The page-scope ledger every mount shares (the agentHeads pattern): a remount replays settled reads. */
const sharedCache = new FleetDetailCache()

export function useFleetDetails(cache: FleetDetailCache = sharedCache): FleetDetailState {
  const [landed, setLanded] = useState<ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>>(new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [scanned, setScanned] = useState<ReadonlySet<string>>(new Set())
  /** Requested stamps, for synchronous dedupe; the cache dedupes the network read too. */
  const requested = useRef(new Map<string, number>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const request = (id: string, updatedAt: number): void => {
    const known = requested.current.get(id)
    if (known !== undefined && known >= updatedAt) return
    requested.current.set(id, updatedAt)
    setPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    void cache.fetch(id, updatedAt).then((detail) => {
      if (!mounted.current) return
      setLanded(prev => new Map(prev).set(id, { detail, updatedAt }))
      setPending((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })
  }

  // Full reads ride their own state maps: an on-demand read must not make the scan's landed entries disagree.
  const [fullLanded, setFullLanded] = useState<ReadonlyMap<string, FleetDetail | null>>(new Map())
  const [fullPending, setFullPending] = useState<ReadonlySet<string>>(new Set())
  const fullRequested = useRef<Set<string>>(new Set())

  const requestFull = (id: string): void => {
    if (fullRequested.current.has(id)) return
    // One full read per session per mount: a settled excerpt line serves an OLDER stamp, which the opened card wants.
    fullRequested.current.add(id)
    setFullPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    void cache.fetch(id, requested.current.get(id) ?? 0, true).then((detail) => {
      if (!mounted.current) return
      setFullLanded(prev => prev.get(id) === detail ? prev : new Map(prev).set(id, detail))
      setFullPending((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })
  }

  const claim = (nodes: readonly AgentNode[]): void => {
    setScanned((prev) => {
      const next = new Set(prev)
      for (const n of nodes) next.add(n.id)
      return next.size === prev.size ? prev : next
    })
  }

  const scan = (nodes: readonly AgentNode[]): void => {
    claim(nodes)
    for (const n of nodes) request(n.id, n.updatedAt)
  }

  const refresh = (nodes: readonly AgentNode[]): void => {
    claim(nodes)
    for (const n of nodes) {
      cache.invalidate(n.id)
      requested.current.delete(n.id)
      fullRequested.current.delete(n.id)
      request(n.id, n.updatedAt)
    }
  }
  return { landed, fullLanded, pending, fullPending, scanned, request, requestFull, scan, refresh }
}
