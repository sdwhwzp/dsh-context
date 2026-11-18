import { CATS, RING_ORDER, billedParts } from '../shared/categories'
import { dayKeyOf, endOfDayKey, startOfDayKey } from '../shared/days'
import { mergeCostUsage } from '../shared/pricing'
import type {
  ActivityDay,
  BackfillCoverage,
  CostBucketTotals,
  OverviewCoverage,
  OverviewDay,
  OverviewGroupCount,
  OverviewPageRow,
  OverviewPartTotal,
  OverviewPick,
  OverviewRange,
  OverviewSort,
  OverviewSummary,
  OverviewTallyField,
  OverviewTallyStat,
  SessionCostUsage,
  Snapshot,
  TimelineLifetime,
  TimingTotals,
} from '../shared/types'
import type { CostSource } from './cost'
import { TIMING_OPTIONAL, optionalNumOf } from './overviewDecode'
import { activityTotalsOf, type HostRow, type HostSession, type HostTimeline, type HostTotals, type WorkspaceState } from './overviewCorpus'

const PAGE_SIZE = 12

const UNGROUPED_KEY = '__ungrouped__'

export interface Window {
  start: number
  end: number | null
  lifetime?: true
  rolling?: true
}

export interface Filters {
  window: Window
  now: number
  day: string | null
  coverage: OverviewCoverage
  group: string | null
  query: string
  pick: OverviewPick | null
}


export function windowOf(
  range: OverviewRange | 'all',
  day: string | null,
  now: number,
  calendar?: { from: string; to: string },
): Window {
  if (day !== null) {
    const start = startOfDayKey(day)
    const end = endOfDayKey(day)
    if (start !== null && end !== null) return { start, end }
  }
  if (calendar !== undefined) {
    const [from, to] = calendar.from <= calendar.to
      ? [calendar.from, calendar.to]
      : [calendar.to, calendar.from]
    const start = startOfDayKey(from)
    const end = endOfDayKey(to)
    if (start !== null && end !== null) return { start, end }
  }
  if (typeof range === 'object') {
    return range.start > range.end
      ? { start: range.end, end: range.start }
      : { start: range.start, end: range.end }
  }
  if (range === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return { start: midnight.getTime(), end: null }
  }
  if (range === 'all') return { start: 0, end: null, lifetime: true }
  return { start: now - (range === '7d' ? 7 : 30) * 86_400_000, end: null, rolling: true }
}

function dayInScope(key: string, scope: Window): boolean {
  if (scope.lifetime === true) return true
  const floor = dayKeyOf(scope.start)
  const ceiling = scope.end === null ? null : dayKeyOf(scope.end)
  return (floor === null || key >= floor) && (ceiling === null || key <= ceiling)
}

function hasActivity(entry: ActivityDay): boolean {
  return entry.tokens > 0 || entry.requests > 0 || (entry.turns ?? 0) > 0
    || (entry.toolCalls ?? 0) > 0 || (entry.wallMs ?? 0) > 0 || entry.skills !== undefined
}

function dayPredicate(filters: Filters): (key: string) => boolean {
  if (filters.day !== null) return key => key === filters.day
  return key => dayInScope(key, filters.window)
}

function inGroup(row: HostRow, group: string | null): boolean {
  if (group === null) return true
  return group === UNGROUPED_KEY ? row.group === undefined : row.group === group
}

function hasTally(row: HostRow, pick: OverviewPick, admit: (key: string) => boolean): boolean {
  const days = row.activity?.days
  if (days === undefined) return false
  for (const key of Object.keys(days)) {
    if (admit(key) && days[key][pick.field]?.[pick.name] !== undefined) return true
  }
  return false
}

export function matches(row: HostRow, filters: Filters): boolean {
  if (filters.coverage !== 'all' && row.archived !== (filters.coverage === 'archived')) return false
  if (!inGroup(row, filters.group)) return false
  let inScope = filters.window.lifetime === true || (row.session.updatedAt >= filters.window.start
    && (filters.window.end === null || row.session.updatedAt <= filters.window.end)
  )
  if (!inScope) {
    const days = row.activity?.days
    if (days !== undefined) {
      for (const key of Object.keys(days)) {
        if (dayInScope(key, filters.window) && hasActivity(days[key])) {
          inScope = true
          break
        }
      }
    }
  }
  if (!inScope) return false
  if (filters.day !== null) {
    const entry = row.activity?.days[filters.day]
    if (entry === undefined || (entry.tokens <= 0 && entry.requests <= 0)) return false
  }
  if (filters.query !== '') {
    const inTitle = row.session.title.toLowerCase().includes(filters.query)
    const inCwd = row.session.cwd !== undefined && row.session.cwd.toLowerCase().includes(filters.query)
    const lastUser = row.session.timeline?.lastUser
    const inLastUser = typeof lastUser === 'string' && lastUser.toLowerCase().includes(filters.query)
    if (!inTitle && !inCwd && !inLastUser) return false
  }
  if (filters.pick !== null && !hasTally(row, filters.pick, dayPredicate(filters))) return false
  return true
}

function emptyUsage(): CostBucketTotals {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

function addUsage(totals: CostBucketTotals, bucket: CostBucketTotals): void {
  totals.uncached += bucket.uncached
  totals.cacheRead += bucket.cacheRead
  totals.cacheWrite += bucket.cacheWrite
  totals.output += bucket.output
}

function usageTotalsOf(usage: SessionCostUsage): CostBucketTotals {
  const totals = emptyUsage()
  for (const models of Object.values(usage)) {
    for (const periods of Object.values(models)) {
      for (const period of ['peak', 'off'] as const) {
        const bucket = periods[period]
        if (bucket !== undefined) addUsage(totals, bucket)
      }
    }
  }
  return totals
}

function inputTokensOf(totals: CostBucketTotals): number {
  return totals.uncached + totals.cacheRead + totals.cacheWrite
}

function billedTokensOf(totals: CostBucketTotals | undefined): number {
  return totals === undefined ? 0 : inputTokensOf(totals) + totals.output
}

function tokenUsageOf(totals: CostBucketTotals): {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
} {
  return {
    uncachedInputTokens: totals.uncached,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    outputTokens: totals.output,
  }
}

function addOptionalOf(target: TimingTotals, source: TimingTotals, key: typeof TIMING_OPTIONAL[number]): void {
  const left = target[key]
  const right = source[key]
  if (left !== undefined || right !== undefined) target[key] = (left ?? 0) + (right ?? 0)
}

function timingSumOf(rows: readonly HostRow[]): TimingTotals | null {
  let out: TimingTotals | null = null
  let toolBusyComplete = true
  for (const row of rows) {
    for (const member of row.family) {
      const timing = ownTimingOf(member, lifetimeOf(member))
      if (timing === undefined) continue
      if (timing.toolBusyMs === undefined) toolBusyComplete = false
      if (out === null) {
        out = { ...timing, tools: { ...timing.tools } }
        continue
      }
      out.wallMs += timing.wallMs
      out.ttftMs += timing.ttftMs
      out.genMs += timing.genMs
      out.calls += timing.calls
      out.toolsMs += timing.toolsMs
      out.toolCalls += timing.toolCalls
      for (const key of TIMING_OPTIONAL) addOptionalOf(out, timing, key)
      for (const name of Object.keys(timing.tools)) {
        const tool = timing.tools[name]
        if (!Object.hasOwn(out.tools, name)) {
          out.tools[name] = { ...tool }
          continue
        }
        out.tools[name] = { calls: out.tools[name].calls + tool.calls, ms: out.tools[name].ms + tool.ms }
      }
    }
  }
  if (out !== null && !toolBusyComplete) delete out.toolBusyMs
  return out
}

function cacheHitOf(totals: CostBucketTotals | null): string | null {
  if (totals === null) return null
  const billed = inputTokensOf(totals)
  if (!(billed > 0)) return null
  const scaled = Math.trunc((totals.cacheRead / billed) * 100 * 100 + 1e-9)
  return `${Math.floor(scaled / 100)}.${String(scaled % 100).padStart(2, '0')}`
}

function lifetimeOf(member: HostSession): TimelineLifetime | undefined {
  const timeline = member.materialization?.values.contextTimeline as Snapshot | undefined
  return timeline?.lifetime
}

function ownTimingOf(member: HostSession, lifetime: TimelineLifetime | undefined): TimingTotals | undefined {
  return lifetime?.postSeed === undefined ? member.timeline?.timing : lifetime.postSeed.timing
}

function modelUsageOf(timeline: HostTimeline | null): SessionCostUsage | null {
  const cost = timeline?.cost
  return cost === undefined || Object.keys(cost).length === 0 ? null : cost
}

const EMPTY_TOTALS: Readonly<HostTotals> = { usage: null, tokens: 0, turns: 0, calls: 0, toolCalls: 0, toolsMs: 0, wallMs: 0 }

function lifetimeTotalsOf(member: HostSession): HostTotals {
  const lifetime = lifetimeOf(member)
  const timing = ownTimingOf(member, lifetime)
  const ledger = lifetime === undefined ? activityTotalsOf(member.activity) : EMPTY_TOTALS
  const usage = modelUsageOf(member.timeline) ?? ledger.usage
  const billed = lifetime === undefined
    ? (usage === null ? undefined : usageTotalsOf(usage))
    : lifetime.usage
  return {
    usage,
    tokens: Math.max(billedTokensOf(billed), ledger.tokens),
    turns: lifetime?.postSeed?.turns ?? member.timeline?.turns ?? ledger.turns,
    calls: timing?.calls ?? ledger.calls,
    toolCalls: timing?.toolCalls ?? ledger.toolCalls,
    toolsMs: timing?.toolsMs ?? ledger.toolsMs,
    wallMs: timing?.wallMs ?? ledger.wallMs,
  }
}

function lifetimeRowOf(row: HostRow): HostRow {
  const totals: HostTotals = { ...EMPTY_TOTALS }
  for (const member of row.family) {
    const next = lifetimeTotalsOf(member)
    totals.usage = mergeCostUsage(totals.usage, next.usage)
    for (const field of ['tokens', 'turns', 'calls', 'toolCalls', 'toolsMs', 'wallMs'] as const) {
      totals[field] += next[field]
    }
  }
  return { ...row, totals }
}

export function rowsForWindow(rows: readonly HostRow[], window: Window): readonly HostRow[] {
  return window.lifetime === true ? rows.map(lifetimeRowOf) : rows
}

function memberUsageOf(member: HostSession, lifetime: boolean, admit: (key: string) => boolean): CostBucketTotals | null {
  if (lifetime) {
    const contribution = lifetimeOf(member)
    if (contribution !== undefined) return contribution.usage ?? null
    const cost = modelUsageOf(member.timeline)
    if (cost !== null) return usageTotalsOf(cost)
  }
  const usage = activityTotalsOf(member.activity, admit).usage
  return usage === null ? null : usageTotalsOf(usage)
}

function partsOf(rows: readonly HostRow[], filters: Filters, admit: (key: string) => boolean): {
  tokenParts: OverviewPartTotal[] | null
  lifetimeUsage: CostBucketTotals | null
} {
  const sums = new Map<string, number>()
  const lifetime = filters.window.lifetime === true
  const lifetimeUsage = lifetime ? emptyUsage() : null
  let any = false
  for (const row of rows) {
    for (const member of row.family) {
      const usage = memberUsageOf(member, lifetime, admit)
      if (usage === null) continue
      if (lifetimeUsage !== null) addUsage(lifetimeUsage, usage)
      const current = member.timeline?.current
      if (current === null || current === undefined) continue
      any = true
      const parts = billedParts(current, null, tokenUsageOf(usage), lifetime ? {
        reasoning: member.timeline?.generatedReasoning,
        answers: member.timeline?.generatedAnswerTokens,
        calls: member.timeline?.generatedCallTokens,
        billed: member.timeline?.billedGenerated,
      } : { unsplit: true })
      for (const part of parts) {
        if (!Number.isFinite(part.value) || part.value <= 0) continue
        sums.set(part.key, (sums.get(part.key) ?? 0) + part.value)
      }
    }
  }
  if (!any) return { tokenParts: null, lifetimeUsage }
  const parts: OverviewPartTotal[] = []
  for (const key of RING_ORDER) {
    const value = sums.get(key)
    if (value === undefined || value <= 0) continue
    parts.push({ key, value })
  }
  return { tokenParts: parts, lifetimeUsage }
}

export function summaryOf(
  allRows: readonly HostRow[],
  rows: readonly HostRow[],
  filters: Filters,
  cost: CostSource,
  coverage: BackfillCoverage,
): OverviewSummary {
  const admit = dayPredicate(filters)
  const { tokenParts, lifetimeUsage } = partsOf(rows, filters, admit)
  const lifetime = filters.window.lifetime === true
  let usage: SessionCostUsage | null = null
  let tokens = 0
  let turns = 0
  const windowTiming = { calls: 0, toolCalls: 0, toolsMs: 0, wallMs: 0 }
  let costSessions = 0
  let usageSessions = 0
  let sessionsArchived = 0
  for (const row of rowsForWindow(rows, filters.window)) {
    const totals = lifetime ? row.totals : activityTotalsOf(row.activity, admit)
    usage = mergeCostUsage(usage, totals.usage)
    tokens += totals.tokens
    turns += totals.turns
    windowTiming.calls += totals.calls
    windowTiming.toolCalls += totals.toolCalls
    windowTiming.toolsMs += totals.toolsMs
    windowTiming.wallMs += totals.wallMs
    if (totals.usage !== null && cost.complete(totals.usage)
      && (!lifetime || billedTokensOf(usageTotalsOf(totals.usage)) >= totals.tokens)) costSessions++
    if (totals.usage !== null || (lifetime && totals.tokens > 0)) usageSessions++
    if (row.archived) sessionsArchived++
  }
  const usageTotals = lifetimeUsage ?? (usage === null ? null : usageTotalsOf(usage))
  return {
    sessions: rows.length,
    sessionsTotal: allRows.length,
    sessionsArchived,
    archivedScoped: sessionsArchived,
    tokens,
    turns,
    costUsd: cost.usd(usage),
    costSessions,
    usageSessions,
    cacheHit: cacheHitOf(usageTotals),
    tokenParts,
    timing: timingSumOf(rows),
    windowTiming,
    window: {
      start: filters.window.start,
      end: filters.window.end,
      from: lifetime ? null : dayKeyOf(filters.window.start),
      to: dayKeyOf(filters.window.end ?? filters.now),
    },
    coverage,
  }
}

export function daysOf(allRows: readonly HostRow[], coverage: OverviewCoverage, cost: CostSource): OverviewDay[] {
  const totals = new Map<string, { tokens: number; sessions: number; requests: number; cost: SessionCostUsage | null }>()
  for (const row of allRows) {
    if (coverage !== 'all' && row.archived !== (coverage === 'archived')) continue
    const days = row.activity?.days
    if (days === undefined) continue
    for (const key of Object.keys(days)) {
      const entry = days[key]
      if (entry.tokens <= 0 && entry.requests <= 0) continue
      const day = totals.get(key) ?? { tokens: 0, sessions: 0, requests: 0, cost: null }
      day.tokens += entry.tokens
      day.requests += entry.requests
      day.sessions += 1
      day.cost = mergeCostUsage(day.cost, entry.cost)
      totals.set(key, day)
    }
  }
  return [...totals]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, day]) => ({ key, tokens: day.tokens, sessions: day.sessions, costUsd: cost.usd(day.cost) }))
}

export function sortOf(rows: readonly HostRow[], sort: OverviewSort): HostRow[] {
  const copy = [...rows]
  if (sort === 'tokens') copy.sort((left, right) => right.totals.tokens - left.totals.tokens)
  else if (sort === 'context') {
    copy.sort((left, right) => (right.session.timeline?.total ?? -1) - (left.session.timeline?.total ?? -1))
  } else {
    copy.sort((left, right) => right.session.updatedAt - left.session.updatedAt)
  }
  return copy
}

export function pageOf<T>(items: readonly T[], page: number): { items: T[]; index: number; count: number } {
  const count = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  const index = Math.min(Math.max(0, page), count - 1)
  return { items: items.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), index, count }
}

function compositionPartsOf(timeline: HostTimeline | null): OverviewPartTotal[] {
  const current = timeline?.current
  if (current === null || current === undefined) return []
  const parts: OverviewPartTotal[] = []
  for (const category of CATS) {
    const value = optionalNumOf(current[category.key])
    if (value !== undefined && value > 0) parts.push({ key: category.key, value })
  }
  return parts
}

export function pageRowOf(row: HostRow, cost: CostSource): OverviewPageRow {
  const session = row.session
  const timeline = session.timeline
  const pageRow: OverviewPageRow = {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    running: row.running,
    archived: row.archived,
    tokens: row.totals.tokens,
    turns: timeline?.turns ?? 0,
    parts: compositionPartsOf(timeline),
    total: timeline?.total ?? 0,
    costUsd: cost.usd(row.totals.usage),
  }
  if (session.cwd !== undefined) pageRow.cwd = session.cwd
  if (row.group !== undefined) pageRow.group = row.group
  if (timeline?.steps !== undefined) pageRow.steps = timeline.steps
  if (timeline?.contextWindow !== undefined) pageRow.contextWindow = timeline.contextWindow
  if (timeline?.maxOutputTokens !== undefined) pageRow.maxOutputTokens = timeline.maxOutputTokens
  if (timeline?.model !== undefined) pageRow.model = timeline.model
  if (timeline?.lastUser !== undefined) pageRow.lastUser = timeline.lastUser
  if (row.createdDay !== undefined) pageRow.createdDay = row.createdDay
  return pageRow
}

export function groupCountsOf(rows: readonly HostRow[], workspace: WorkspaceState): OverviewGroupCount[] {
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    if (row.group === undefined) ungrouped++
    else counts.set(row.group, (counts.get(row.group) ?? 0) + 1)
  }
  const groups: OverviewGroupCount[] = []
  for (const title of workspace.titles) {
    const count = counts.get(title) ?? 0
    if (count > 0) groups.push({ key: title, count })
  }
  if (ungrouped > 0) groups.push({ key: UNGROUPED_KEY, count: ungrouped })
  return groups
}

export function tallyStatsOf(rows: readonly HostRow[], filters: Filters, field: OverviewTallyField): OverviewTallyStat[] {
  const admit = dayPredicate(filters)
  const stats = new Map<string, OverviewTallyStat>()
  for (const row of rows) {
    const days = row.activity?.days
    if (days === undefined) continue
    const rowHas = new Set<string>()
    for (const key of Object.keys(days)) {
      if (!admit(key)) continue
      const table = days[key][field]
      if (table === undefined) continue
      for (const name of Object.keys(table)) {
        const tally = table[name]
        const prev = stats.get(name)
        if (prev === undefined) stats.set(name, { name, n: tally.n, sessions: 1, last: tally.last })
        else {
          prev.n += tally.n
          prev.last = Math.max(prev.last, tally.last)
          if (!rowHas.has(name)) prev.sessions += 1
        }
        rowHas.add(name)
      }
    }
  }
  return [...stats.values()].sort((left, right) => (right.n - left.n)
    || (right.last - left.last)
    || (left.name < right.name ? -1 : 1))
}
