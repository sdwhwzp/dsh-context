import type { PartsPart } from './categories'
import type { ContextBreakdown, ContextPressure, ContextTimeline, SessionCostUsage, TokenUsage } from '../shared/types'
import { mergeCostUsage } from './cost'
import { headlineOf, occupancyPercent, type Headline } from './headline'
import { asRecord, contextBreakdownOf, contextPressureOf, numOf, timelineOf, tokenUsageOf } from './services'

export interface SessionsFaceLike {
  list?: {
    getSnapshot(): unknown
    subscribe(fn: () => void): () => void
  }
  refreshSubagents?(parentSessionId: string): Promise<unknown>
}

export interface AgentRow {
  displayTitle?: string
  title?: string
  parentId?: string
  origin?: 'subagent'
  running: boolean
  blank: boolean
  updatedAt: number
  projections?: Record<string, unknown>
}

/** The subagent domain's `subagent` identity projection (descriptor mode + durable label). */
export interface AgentIdentity {
  mode: 'one-shot' | 'continuable'
  label?: string
}

export interface AgentStats {
  head: Headline | null
  requests: number
  billed: number | null
  costUsage: SessionCostUsage | null
  durationMs: number | null
  identity: AgentIdentity | null
  model?: string
  reasoningEffort?: string
}

export interface AgentSelfStats {
  head: Headline | null
  billed: number | null
  requests: number
  costUsage?: SessionCostUsage | null
  /** The current session's whole-step time (`data.timing.wallMs`); a parent never carries `subagentTiming`. */
  durationMs?: number | null
}

export interface AgentNode extends AgentStats {
  id: string
  label: string
  parentId?: string
  depth: number
  /** Which level-1 subtree this node belongs to (root = -1) — drives the family link hue. */
  family: number
  isCurrent: boolean
  running: boolean
  completed: boolean
  subagent: boolean
  /** The list row's change stamp — the fleet-detail cache's freshness key. */
  updatedAt: number
}

export interface AgentForest {
  /** DFS pre-order (parents ahead of their children). */
  nodes: AgentNode[]
  edges: { from: string; to: string }[]
  solo: boolean
}

/** Fixed card height, mirrored by `.lc-agent-card`'s `height` in agentGraph.css so links meet the card edge. */
export const AGENT_CARD_H = 116
/** One cell per node, the card filling it minus `CARD_GUTTER`, so no card clips a neighbor or the stage edge. */
const SLOT_MAX = 276
const SLOT_MIN = 190
const CARD_GUTTER = 12
/** Card height plus a dedicated 64px link channel, tall enough for the S-curves to read as separate strands. */
const LEVEL_H = AGENT_CARD_H + 64
const PAD_Y = 48

/** Session-list rows are immutable snapshots, so one derivation per row object serves every panel and every push. */
const rowCache = new WeakMap<object, AgentRow>()

export function agentRowOf(value: unknown): AgentRow | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const cached = rowCache.get(rec)
  if (cached !== undefined) return cached
  const projections = asRecord(rec.projectionValues)
  const row: AgentRow = {
    ...(typeof rec.displayTitle === 'string' ? { displayTitle: rec.displayTitle } : {}),
    ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
    ...(typeof rec.parentId === 'string' ? { parentId: rec.parentId } : {}),
    ...(rec.origin === 'subagent' ? { origin: rec.origin } : {}),
    running: rec.running === true,
    blank: rec.blank === true,
    updatedAt: numOf(rec.updatedAt),
    ...(projections !== null ? { projections } : {}),
  }
  rowCache.set(rec, row)
  return row
}

/** A family edge is a subagent child only: a fork seed carries `parentId` but no `origin`, so it roots its own family. */
export function familyParentOf(row: AgentRow | undefined): string | undefined {
  return row !== undefined && row.origin === 'subagent' ? row.parentId : undefined
}

/** The pair must come from one source — the live envelope or the declared descriptor. */
export function modelLabelOf(model: string | undefined, effort: string | undefined): string | undefined {
  if (model === undefined) return undefined
  return effort === undefined ? model : `${model} (${effort})`
}

/** `provider · model (effort)`; empty or absent parts drop without a lone separator. */
export function providerModelLabelOf(
  provider: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): string {
  const label = modelLabelOf(model || undefined, effort)
  if (label === undefined) return provider ?? ''
  return provider ? `${provider} · ${label}` : label
}

export function agentIdentityOf(value: unknown): AgentIdentity | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (rec.mode !== 'one-shot' && rec.mode !== 'continuable') return null
  return {
    mode: rec.mode,
    ...(typeof rec.label === 'string' && rec.label !== '' ? { label: rec.label } : {}),
  }
}

export function agentDurationOf(value: unknown): number | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const settled = numOf(rec.settledMs)
  const active = asRecord(rec.active)
  const openMs = active !== null ? Math.max(0, numOf(active.through) - numOf(active.since)) : 0
  const total = settled + openMs
  return total > 0 ? total : null
}

/** The harness's own done signal: the last closed turn after the child's descriptor finished normally. */
export function agentTurnCompletedOf(value: unknown): boolean {
  return asRecord(value)?.lastTurnCompleted === true
}

/** Fold a row's projection values into stats, preferring the plugin's own `contextTimeline`. */
export function agentStatsOf(values: Record<string, unknown> | undefined): AgentStats {
  const timeline = timelineOf(values?.contextTimeline)
  const pressure = contextPressureOf(values?.contextPressure)
  const breakdown = contextBreakdownOf(values?.contextBreakdown)
  const usage = tokenUsageOf(values?.tokenUsage)
  let head: Headline | null = null
  if (timeline !== null) {
    head = headlineOf(timeline, pressure, breakdown)
  } else if (pressure !== null) {
    const tokens = typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
      : typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens
        : null
    if (tokens !== null) {
      const window = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
        ? pressure.contextWindow
        : undefined
      head = {
        tokens,
        window,
        pct: window !== undefined ? occupancyPercent(tokens, window) : null,
        parts: [],
      }
    }
  }
  return {
    head,
    // The split-generation wire head carries the tally precomputed; the inline generation's rows count their served records.
    requests: timeline !== null ? (timeline.counts?.steps ?? timeline.requests.length) : 0,
    billed: billedOf(usage),
    costUsage: timeline?.cost ?? null,
    durationMs: agentDurationOf(values?.subagentTiming),
    identity: agentIdentityOf(values?.subagent),
    ...(timeline !== null && typeof timeline.model === 'string' ? { model: timeline.model } : {}),
    ...(timeline !== null && typeof timeline.reasoningEffort === 'string' ? { reasoningEffort: timeline.reasoningEffort } : {}),
  }
}

function billedOf(usage: TokenUsage | null): number | null {
  return usage !== null
    ? numOf(usage.uncachedInputTokens) + numOf(usage.outputTokens) + numOf(usage.cacheReadTokens) + numOf(usage.cacheWriteTokens)
    : null
}

/** The current session's live stats off the VIEW's projections; a top-level session carries no `subagentTiming`. */
export function agentSelfOf(
  timeline: ContextTimeline,
  pressure: ContextPressure | null,
  breakdown: ContextBreakdown | null,
  usage: TokenUsage | null,
): AgentSelfStats {
  return {
    head: headlineOf(timeline, pressure, breakdown),
    billed: billedOf(usage),
    requests: timeline.counts?.steps ?? timeline.requests.length,
    costUsage: timeline.cost ?? null,
    durationMs: timeline.timing != null && timeline.timing.wallMs > 0 ? timeline.timing.wallMs : null,
  }
}

/** Spawn-order ranks from the parent's `subagentCatalog`; absent, empty, or hostile values yield null. */
export function catalogOrderOf(values: Record<string, unknown> | undefined): Map<string, number> | null {
  const cat = values?.subagentCatalog
  if (!Array.isArray(cat)) return null
  const order = new Map<string, number>()
  for (const entry of cat) {
    const rec = asRecord(entry)
    if (rec === null || typeof rec.id !== 'string' || rec.id === '') continue
    if (!order.has(rec.id)) order.set(rec.id, order.size)
  }
  return order.size > 0 ? order : null
}

export interface AgentChild {
  id: string
  row: AgentRow
}

export function familyChildrenOf(rows: ReadonlyMap<string, AgentRow>): Map<string, AgentChild[]> {
  const childrenOf = new Map<string, AgentChild[]>()
  for (const [id, row] of rows) {
    const parentId = familyParentOf(row)
    if (parentId === undefined) continue
    const list = childrenOf.get(parentId) ?? []
    list.push({ id, row })
    childrenOf.set(parentId, list)
  }
  return childrenOf
}

/** Build the family from the topmost known ancestor's whole subtree; `fetched` heads fill cold relatives.
 * Null when the snapshot/current id is unusable; blank rows are excluded. */
export function agentForestOf(
  snapshot: unknown,
  currentId: string | undefined,
  self?: AgentSelfStats,
  fetched?: ReadonlyMap<string, unknown>,
): AgentForest | null {
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null || currentId === undefined || currentId === '') return null

  const rows = new Map<string, AgentRow>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    // Blank placeholder sessions (never engaged) are not agents; the current session always stays.
    if (row !== null && (!row.blank || key === currentId)) rows.set(key, row)
  }
  if (!rows.has(currentId)) {
    rows.set(currentId, { running: false, blank: false, updatedAt: 0 })
  }

  // Topmost known ancestor; a lineage cycle anchors at the first repeated id.
  let root = currentId
  const chain = new Set<string>([currentId])
  for (;;) {
    const parent = familyParentOf(rows.get(root))
    if (parent === undefined || !rows.has(parent) || chain.has(parent)) break
    chain.add(parent)
    root = parent
  }
  const rootRow = rows.get(root)
  /* v8 ignore next 2 -- root is currentId (inserted above) or a parent verified with rows.has, so its row always exists. */
  if (rootRow === undefined) return null

  const childrenOf = familyChildrenOf(rows)
  for (const [pid, kids] of childrenOf) {
    // Sibling order follows the parent's subagent catalog when cached; uncataloged children fall after
    // cataloged ones, and catalog-less parents keep the heuristic.
    const order = catalogOrderOf(rows.get(pid)?.projections)
    kids.sort((a, b) => {
      const ra = order?.get(a.id)
      const rb = order?.get(b.id)
      if (ra !== undefined || rb !== undefined) {
        // Catalog ranks are unique per parent, so two ranked ids never tie here.
        if (ra === undefined) return 1
        if (rb === undefined) return -1
        return ra - rb
      }
      const runDelta = Number(b.row.running) - Number(a.row.running)
      if (runDelta !== 0) return runDelta
      const timeDelta = b.row.updatedAt - a.row.updatedAt
      return timeDelta !== 0 ? timeDelta : (a.id < b.id ? -1 : 1)
    })
  }

  const nodes: AgentNode[] = []
  const edges: { from: string; to: string }[] = []
  const visit = (id: string, row: AgentRow, parentId: string | undefined, depth: number, seen: Set<string>, family: number): void => {
    if (seen.has(id)) return
    seen.add(id)
    const values = row.projections
    const fetchedHead = fetched !== undefined ? fetched.get(id) : undefined
    const stats = agentStatsOf(fetchedHead !== undefined && values?.contextTimeline === undefined
      ? { ...values, contextTimeline: fetchedHead }
      : values)
    const identity = stats.identity
    if (id === currentId && self !== undefined) {
      stats.head = self.head ?? stats.head
      stats.billed = self.billed ?? stats.billed
      stats.requests = self.requests > 0 ? self.requests : stats.requests
      stats.costUsage = self.costUsage ?? stats.costUsage
      stats.durationMs = self.durationMs ?? stats.durationMs
    }
    const subagent = row.origin === 'subagent' || identity !== null
    const node: AgentNode = {
      ...stats,
      id,
      label: identity?.label ?? row.title ?? row.displayTitle ?? id,
      ...(parentId !== undefined ? { parentId } : {}),
      depth,
      family,
      isCurrent: id === currentId,
      running: row.running,
      // Done by the harness popup's rule: a stopped agent whose last closed subagent turn finished normally.
      completed: !row.running
        && (agentTurnCompletedOf(values?.subagentTiming) || (!subagent && stats.requests > 0)),
      subagent,
      updatedAt: row.updatedAt,
    }
    nodes.push(node)
    if (parentId !== undefined) edges.push({ from: parentId, to: id })
    const kids = childrenOf.get(id) ?? []
    kids.forEach((kid, ki) => {
      visit(kid.id, kid.row, id, depth + 1, seen, depth === 0 ? ki : family)
    })
  }
  visit(root, rootRow, undefined, 0, new Set(), -1)

  return { nodes, edges, solo: nodes.length === 1 }
}

/** Display titles for every row in a sessions snapshot, so a party outside the viewed family still has a readable name.
 * A teammate session's generated title can be its injected `<system-reminder>` briefing; its subagent descriptor label is
 * the clean fallback. */
const titleCache = new WeakMap<object, string | null>()

function titleOfRow(value: unknown): string | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const cached = titleCache.get(rec)
  if (cached !== undefined) return cached
  const row = agentRowOf(value)
  const clean = (text: string | undefined): string | undefined => {
    if (text === undefined || text.trim() === '') return undefined
    return text.includes('<system-reminder>') ? undefined : text
  }
  // The descriptor label is read only when no clean title exists, so a corrupt descriptor cannot hide a title.
  const label = (): string | undefined => {
    const subagent = asRecord(asRecord(rec.projectionValues)?.subagent)
    return typeof subagent?.label === 'string' && subagent.label !== '' ? subagent.label : undefined
  }
  const name = clean(row?.displayTitle) ?? clean(row?.title) ?? label() ?? null
  titleCache.set(rec, name)
  return name
}

export function sessionTitlesOf(snapshot: unknown): Map<string, string> {
  const byId = asRecord(asRecord(snapshot)?.byId)
  const titles = new Map<string, string>()
  if (byId === null) return titles
  for (const id of Object.keys(byId)) {
    try {
      const name = titleOfRow(byId[id])
      if (name !== null) titles.set(id, name)
    } catch {
      // A corrupt session descriptor cannot hide other parties' names.
    }
  }
  return titles
}

export interface SubagentCostFold {
  usage: SessionCostUsage | null
  /** Descendants with no timeline row and no landed head — the slim-head fetch targets. */
  cold: string[]
  count: number
}

/** Merge the SUBAGENT subtree cost: warm `contextTimeline` costs first, fetched heads for rows without one. */
export function subagentCostFoldOf(
  snapshot: unknown,
  currentId: string | undefined,
  landed?: ReadonlyMap<string, ContextTimeline>,
): SubagentCostFold {
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null || currentId === undefined || currentId === '') return { usage: null, cold: [], count: 0 }
  const rows = new Map<string, AgentRow>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    if (row !== null && !row.blank) rows.set(key, row)
  }
  const childrenOf = familyChildrenOf(rows)
  const parts: SessionCostUsage[] = []
  const cold: string[] = []
  const seen = new Set<string>([currentId])
  const queue = [currentId]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const kid of childrenOf.get(id) ?? []) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      const head = landed?.get(kid.id)
      const values = kid.row.projections
      if (values?.contextTimeline === undefined) {
        // A cold relative's usage rides its fetched head; until one lands the id stays a fetch target.
        // A landed head is final either way — a failed fetch also stops the refetch.
        if (head === undefined) cold.push(kid.id)
        else if (head.cost !== undefined) parts.push(head.cost)
      } else {
        const cost = timelineOf(values.contextTimeline)?.cost
        if (cost !== undefined) parts.push(cost)
      }
      queue.push(kid.id)
    }
  }
  return { usage: parts.length > 0 ? mergeCostUsage(...parts) : null, cold, count: seen.size - 1 }
}

export interface AgentPoint {
  id: string
  x: number
  y: number
  depth: number
}

export interface AgentLink {
  to: string
  running: boolean
  color: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface AgentLayout {
  width: number
  height: number
  cardW: number
  points: AgentPoint[]
  links: AgentLink[]
}

/** Tidy top-down layout: siblings claim leaf slots, parents center; an overflowing level wraps into bands. */
export function layoutForest(forest: AgentForest, stageWidth = 0): AgentLayout {
  // Nodes are DFS pre-order, so plain iteration appends children in visit order.
  const childrenOf = new Map<string, AgentNode[]>()
  for (const n of forest.nodes) {
    if (n.parentId === undefined) continue
    const kids = childrenOf.get(n.parentId) ?? []
    kids.push(n)
    childrenOf.set(n.parentId, kids)
  }

  const slotOf = new Map<string, number>()
  let leafSlots = 0
  const place = (node: AgentNode): number => {
    const kids = childrenOf.get(node.id) ?? []
    if (kids.length === 0) {
      const slot = leafSlots
      leafSlots++
      slotOf.set(node.id, slot)
      return slot
    }
    let first = 0
    let last = 0
    kids.forEach((kid, index) => {
      const slot = place(kid)
      if (index === 0) first = slot
      last = slot
    })
    const slot = (first + last) / 2
    slotOf.set(node.id, slot)
    return slot
  }
  /** v8 ignore next 1 -- a forest always holds at least the (possibly synthesized) current node. */
  if (forest.nodes.length > 0) place(forest.nodes[0])

  const perLevel = stageWidth > 0 ? Math.max(1, Math.floor(stageWidth / SLOT_MIN)) : 0

  if (perLevel > 0 && leafSlots > perLevel) {
    // Wrapped bands interleave by kinship, so sibling groups never split unless one group exceeds the band.
    const bandSlot = Math.min(SLOT_MAX, stageWidth / perLevel)
    const width = perLevel * bandSlot
    const points: AgentPoint[] = []
    let row = 0
    const emitBand = (nodes: AgentNode[], depth: number): void => {
      const inset = (width - nodes.length * bandSlot) / 2
      nodes.forEach((node, i) => {
        points.push({ id: node.id, x: inset + (i + 0.5) * bandSlot, y: PAD_Y + row * LEVEL_H, depth })
      })
      row++
      let band: AgentNode[] = []
      const flush = (): void => {
        if (band.length === 0) return
        const packed = band
        band = []
        emitBand(packed, depth + 1)
      }
      for (const node of nodes) {
        const kids = childrenOf.get(node.id) ?? []
        for (let start = 0; start < kids.length; start += perLevel) {
          const group = kids.slice(start, start + perLevel)
          if (band.length + group.length > perLevel) flush()
          band.push(...group)
          if (band.length === perLevel) flush()
        }
      }
      flush()
    }
    /* v8 ignore next 1 -- a forest always holds at least the current node. */
    if (forest.nodes.length > 0) emitBand([forest.nodes[0]], 0)
    return {
      width,
      height: PAD_Y + (row - 1) * LEVEL_H + AGENT_CARD_H + 24,
      cardW: bandSlot - CARD_GUTTER,
      points,
      links: linksOf(forest, points),
    }
  }

  // Adaptive pitch; 0 = unmeasured stage (the natural maximum).
  const slot = stageWidth > 0 && leafSlots > 1 ? Math.min(SLOT_MAX, stageWidth / leafSlots) : SLOT_MAX
  const points: AgentPoint[] = forest.nodes.map(node => ({
    id: node.id,
    /** v8 ignore next 1 -- place() visits every node: the forest is exactly the root's subtree by construction. */
    x: (slotOf.get(node.id) ?? 0) * slot + slot / 2,
    y: PAD_Y + node.depth * LEVEL_H,
    depth: node.depth,
  }))
  const maxDepth = points.reduce((max, p) => Math.max(max, p.depth), 0)
  return {
    width: leafSlots * slot,
    height: PAD_Y + maxDepth * LEVEL_H + AGENT_CARD_H + 24,
    cardW: slot - CARD_GUTTER,
    points,
    links: linksOf(forest, points),
  }
}

/** Family hue by level-1 subtree index: the golden angle keeps consecutive families separated. */
export function familyHue(index: number): string {
  return `hsl(${Math.round(index * 137.508) % 360} 58% 52%)`
}

/** The lead/current agent's hue: the shell's brand color, shared by the graph, boards, and comms avatars. */
export const BRAND_HUE = 'var(--dsw-alias-brand-primary, var(--color-blue-500))'

function linksOf(forest: AgentForest, points: AgentPoint[]): AgentLink[] {
  const pointOf = new Map(points.map(p => [p.id, p]))
  const nodeOf = new Map(forest.nodes.map(n => [n.id, n]))
  const runningIds = new Set(forest.nodes.filter(n => n.running).map(n => n.id))
  const links: AgentLink[] = []
  for (const edge of forest.edges) {
    const from = pointOf.get(edge.from)
    const to = pointOf.get(edge.to)
    /** v8 ignore next 2 -- edges are emitted only for visited parent/child pairs, so both points always exist. */
    if (from === undefined || to === undefined) continue
    links.push({
      to: edge.to,
      running: runningIds.has(edge.to),
      /* v8 ignore next 1 -- edges only connect visited nodes. */
      color: familyHue(nodeOf.get(edge.to)?.family ?? 0),
      // Out of the parent's bottom edge, into the child's top; a wrapped band's curve passes BEHIND the rows between.
      x1: from.x,
      y1: from.y + AGENT_CARD_H,
      x2: to.x,
      y2: to.y,
    })
  }
  return links
}

/** The hovered node's lineage: ancestor chain plus whole subtree — the links that light up under focus. */
export function lineageOf(forest: AgentForest, id: string | null): Set<string> | null {
  if (id === null) return null
  const byId = new Map(forest.nodes.map(n => [n.id, n]))
  const start = byId.get(id)
  if (start === undefined) return null
  const childrenOf = new Map<string, string[]>()
  for (const n of forest.nodes) {
    if (n.parentId === undefined) continue
    const kids = childrenOf.get(n.parentId) ?? []
    kids.push(n.id)
    childrenOf.set(n.parentId, kids)
  }
  const lit = new Set<string>()
  let cur: AgentNode | undefined = start
  while (cur !== undefined) {
    lit.add(cur.id)
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined
  }
  const queue = [id]
  // A single-parent tree cannot lead back into the already-lit ancestor chain.
  for (let i = 0; i < queue.length; i++) {
    for (const kid of childrenOf.get(queue[i]) ?? []) {
      lit.add(kid)
      queue.push(kid)
    }
  }
  return lit
}

export interface BarSeg {
  key: string
  color: string
  share: number
  free: boolean
}

export function pressureColorOf(pct: number | null): string {
  if (pct === null) return 'var(--dsw-alias-border-l1)'
  if (pct >= 90) return 'var(--color-red-500)'
  if (pct >= 70) return 'var(--color-amber-500)'
  return 'var(--color-green-500)'
}

/** The composer ring's semantics flattened: parts fill the bar scaled to occupancy, a neutral remainder closes it. */
export function barSegments(parts: PartsPart[], pct: number | null, fallbackColor: string): BarSeg[] {
  const occ = pct === null ? 1 : Math.min(100, Math.max(0, pct)) / 100
  let total = 0
  for (const p of parts) total += p.value > 0 ? p.value : 0
  const segs: BarSeg[] = []
  let acc = 0
  if (total > 0) {
    for (const p of parts) {
      if (p.value <= 0) continue
      const share = (p.value / total) * occ
      if (share <= 0) continue
      segs.push({ key: p.key, color: p.color, share, free: false })
      acc += share
    }
  } else if (pct !== null && occ > 0) {
    segs.push({ key: 'fill', color: fallbackColor, share: occ, free: false })
    acc = occ
  }
  if (pct !== null && acc < 1) {
    segs.push({ key: 'free', color: '', share: 1 - acc, free: true })
  }
  return segs
}

export function sessionsFaceOf(ctx: { get(name: string): unknown }): SessionsFaceLike | null {
  const rec = asRecord(ctx.get('sessions'))
  if (rec === null) return null
  const list = asRecord(rec.list)
  if (list === null || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
  return rec
}

/** Compact duration, distinct from `format.ts`'s `fmtDuration` (decimal seconds do not fit the caption column). */
export function fmtDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
