/**
 * The four-lane session ledger uses host projection counts. Authorized
 * dsh-spend quotes supply the family cost and currency; without a quote,
 * models.dev supplies estimates. Agent-share estimates remain separate.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode, TimelineCounts } from '../../shared/types'
import { estimateSessionCost, billedTokensOf, formatCost, formatPriceRate, mergeCostUsage, priceLookupsOf, toCurrency } from '../cost'
import type { CostCurrency, ModelBook, PriceFace, PriceMiss } from '../cost'
import { agentForestOf, familyHue, sessionsFaceOf, subagentCostFoldOf } from '../agentTree'
import { useSessionsSnapshot } from '../agentHeads'
import type { AgentHeads } from '../agentHeads'
import type { Translate } from '../i18n'
import { useModelPrices } from '../modelPrices'
import { spendTokensOf, type ClientCtx } from '../services'
import type { SessionSpend } from '../services'
import { formatSpendCost, spendDisplayCurrency } from '../spendMoney'
import { isDeepSeekProvider } from '../../shared/providers'
import type { ViewKit } from '../viewkit'

interface PriceRow { key: string; face: PriceFace }
interface PriceMissRow { key: string; provider: string; model: string; miss: PriceMiss }

const BANDS: readonly (readonly [keyof PriceFace['rate'], string])[] = [
  ['hit', 'stats.costHit'],
  ['miss', 'stats.costMiss'],
  ['write', 'stats.costWrite'],
  ['out', 'stats.costOut'],
]

function pricesOf(usage: SessionCostUsage | undefined, book: ModelBook | null): { rows: PriceRow[]; misses: PriceMissRow[] } {
  if (usage === undefined || book === null) return { rows: [], misses: [] }
  const rows: PriceRow[] = []
  const misses: PriceMissRow[] = []
  for (const lookup of priceLookupsOf(usage, book)) {
    const key = lookup.provider + '/' + lookup.model
    if (lookup.face !== null) rows.push({ key, face: lookup.face })
    else misses.push({ key, provider: lookup.provider, model: lookup.model, miss: lookup.miss })
  }
  return { rows, misses }
}

/** Inline counter derivation; the host's split-generation counts match it by construction (fold.ts buildTimelineHead). */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // Loaded skills: distinct names among skill-tagged injects — the host fold's tag set (`sub: 'skill'`).
  const skills = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
    if (ev.sub === 'skill' && typeof ev.name === 'string' && ev.name !== '') skills.add(ev.name)
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes, skills: skills.size }
}

/** null usage = nothing reported (no subagents, no usage, or no sessions face on this harness). */
export interface SubagentStats {
  usage: SessionCostUsage | null
  count: number
  /** The DESCENDANT roster in family order — the same subtree the count folds: id, label, family hue. */
  members: { id: string; label: string; family: number }[]
}

export function makeSubagentCost(
  ctx: ClientCtx,
  heads: AgentHeads,
): (sessionId: string | undefined) => SubagentStats {
  return function useSubagentCost(sessionId: string | undefined): SubagentStats {
    const face = useMemo(() => sessionsFaceOf(ctx), [])
    const snapshot = useSessionsSnapshot(face)
    const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())
    const fold = useMemo(
      () => subagentCostFoldOf(snapshot, sessionId, landed),
      [snapshot, sessionId, landed],
    )
    // The forest anchors at the TOPMOST ancestor, so the roster walks the edges DOWN from the current session —
    // the same subtree `subagentCostFoldOf` counts, never a parent's siblings.
    const members = useMemo(() => {
      const forest = agentForestOf(snapshot, sessionId)
      if (forest === null || sessionId === undefined || sessionId === '') return []
      const byId = new Map(forest.nodes.map(n => [n.id, n]))
      const children = new Map<string, string[]>()
      for (const e of forest.edges) {
        const kids = children.get(e.from)
        if (kids === undefined) children.set(e.from, [e.to])
        else kids.push(e.to)
      }
      const out: { id: string; label: string; family: number }[] = []
      const queue = [sessionId]
      const seen = new Set(queue)
      for (let i = 0; i < queue.length; i++) {
        for (const kid of children.get(queue[i]) ?? []) {
          /* v8 ignore next 3 -- agentForestOf's edge set is cycle-free. */
          if (seen.has(kid)) continue
          seen.add(kid)
          const node = byId.get(kid)
          /* v8 ignore next 1 -- every edge target is one of that forest's nodes. */
          if (node === undefined) continue
          out.push({ id: node.id, label: node.label, family: node.family })
          queue.push(kid)
        }
      }
      return out
    }, [snapshot, sessionId])
    // Same value → same state: the identity bail-out keeps a settled replay on every snapshot tick from looping.
    useEffect(() => {
      for (const id of fold.cold) {
        void heads.headOf(id).then((head) => {
          if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
        }).catch(() => {})
      }
    }, [fold, heads])
    return { usage: fold.usage, count: fold.count, members }
  }
}

const EVENT_PILLS: readonly { kind: 'inject' | 'compaction' | 'prune'; tally: 'injects' | 'compactions' | 'prunes'; cls: string }[] = [
  { kind: 'inject', tally: 'injects', cls: 'lc-kind-inject' },
  { kind: 'compaction', tally: 'compactions', cls: 'lc-kind-compaction' },
  { kind: 'prune', tally: 'prunes', cls: 'lc-kind-prune' },
]

/** The LIVE surface folded with the host's own predicate (fold.ts `toolCalls`), so the pills sum to the head's
 * `toolCalls` figure by construction, minus any result the fold stamped no name on. */
export function toolTallyOf(nodes: readonly SurfaceNode[]): [string, number][] {
  const tally = new Map<string, number>()
  for (const n of nodes) {
    if (n.cat !== 'tool' && !(n.cat === 'skill' && n.tool !== undefined)) continue
    if (typeof n.tool !== 'string' || n.tool === '') continue
    tally.set(n.tool, (tally.get(n.tool) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

export type StatsJump = 'skills' | 'answers' | 'inputs' | 'read' | 'write' | 'search' | 'image'

const JUMP_TIPS: Record<StatsJump, string> = {
  skills: 'stats.skillsJump',
  answers: 'stats.answersJump',
  inputs: 'stats.userJump',
  read: 'stats.filesJump',
  write: 'stats.filesJump',
  search: 'stats.filesJump',
  image: 'stats.filesJump',
}

interface JumpWire {
  role: 'button'
  tabIndex: number
  title?: string
  onClick: () => void
  onKeyDown: (ev: KeyboardEvent) => void
}

/** One keyboard-and-click wire for every jumpable chip: Enter/Space fires, any other key passes through. */
function pickWire(title: string | undefined, fire: () => void): JumpWire {
  return {
    role: 'button',
    tabIndex: 0,
    title,
    onClick: fire,
    onKeyDown: (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      fire()
    },
  }
}

interface StatsContextProps {
  counts: TimelineCounts
  humanInputs?: number
  answers?: number
  onJump?: (jump: StatsJump) => void
  onTeamClick?: () => void
  /** The tool lane's chip pick: open the tool's results in the Context Browser. */
  onToolPick?: (tool: string) => void
  /** The command lane's chip pick: filter that program in the Command Executions card. */
  onCommandPick?: (program: string) => void
  /** The roster's chip pick: highlight that member in the Agent Network. */
  onMemberPick?: (id: string) => void
  toolCalls?: number
  files: { reads: number; writes: number; searches: number; images: number }
  tools: readonly (readonly [string, number])[]
  /** The execution log's headline runs and its top programs; absent (or empty) on hosts before the collection. */
  commands?: { runs: number; top: readonly (readonly [string, number])[] }
  cost?: SessionCostUsage
  /** Authorized session-family quote supplied by dsh-spend. */
  spend?: SessionSpend | null
  locale: string
  sessionId?: string
}

/** The I/O lane's identity colors: file kinds carry the File Activity card's own chip colors (a jump keeps its
 *  color across cards), human inputs the user category's green, image reads the output pink. */
const IO_COLOR: Record<'inputs' | 'read' | 'write' | 'search' | 'image', string> = {
  inputs: 'var(--color-green-500)',
  read: 'var(--dsw-alias-brand-primary)',
  write: 'var(--dsw-alias-state-success-primary)',
  search: 'var(--dsw-alias-state-warn-primary)',
  image: 'var(--color-pink-500)',
}

/** Tool chips shade by rank in the tool category's teal; the unnamed rest reads neutral. */
const TOOL_SHADE = (rank: number): string =>
  `color-mix(in srgb, var(--color-teal-500) ${Math.max(38, 100 - rank * 21)}%, transparent)`
const TOOL_REST = 'color-mix(in srgb, var(--color-neutral-500) 40%, transparent)'

/** The subagents lane spells out at most four names by ROSTER POSITION; the tail folds into the "+N" chip. */
const SUB_MEMBERS_MAX = 4

/** The tool lane's own gap, mirrored from `.lc-ledger-chips` in stats.css so the fit arithmetic matches the rendered box. */
const CHIP_GAP = 3

interface ToolChipsProps {
  tools: readonly (readonly [string, number])[]
  onPick?: (tool: string) => void
  t: Translate
  fmt: (n: number) => string
}

/** The tool lane's chip row: only the tally that fits renders (measured off a hidden gauge) and the tail folds into
 *  the "+N" chip, so the lane's height depends on the card's width alone and nothing is clipped. */
function ToolChips(props: ToolChipsProps): ReactElement {
  const { tools, onPick, t, fmt } = props
  const rowRef = useRef<HTMLDivElement | null>(null)
  const gaugeRef = useRef<HTMLDivElement | null>(null)
  const chipGaugeRef = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(tools.length)

  const chip = (name: string, n: number, rank: number, hint = false): ReactElement => {
    const wire = hint && onPick !== undefined ? pickWire(t('stats.toolJump'), () => { onPick(name) }) : undefined
    return (
      <span
        key={name}
        className={'lc-ledger-chip' + (wire !== undefined ? ' lc-ledger-chip-btn' : '')}
        {...(wire ?? { title: name })}
      >
        <i style={{ background: TOOL_SHADE(rank) }} />
        <span className="lc-ledger-chip-label">{name}</span>
        <b>{fmt(n)}</b>
      </span>
    )
  }

  const fit = useCallback(() => {
    const row = rowRef.current
    const gauge = gaugeRef.current
    const chipGauge = chipGaugeRef.current
    /* v8 ignore next 3 -- the gauges always render, so their refs are set whenever the row is. */
    if (row === null || gauge === null || chipGauge === null) return
    const width = row.getBoundingClientRect().width
    // Nothing measurable (a hidden pane, jsdom, a top-only rect stub): show the whole tally rather than guessing a subset.
    if (!(width > 0)) {
      setShown(tools.length)
      return
    }
    const widths = Array.from(gauge.children, el => el.getBoundingClientRect().width)
    const chips = Array.from(chipGauge.children, el => el.getBoundingClientRect().width)
    // Widest set that fits WITH the chip it would carry, top down: measuring the live chip would feed the pass its own output.
    let pills = 0
    for (let n = Math.min(widths.length, chips.length - 1); n >= 0; n--) {
      let total = chips[tools.length - n] + n * CHIP_GAP
      for (let i = 0; i < n; i++) total += widths[i]
      if (total <= width) {
        pills = n
        break
      }
    }
    setShown(prev => (prev === pills ? prev : pills))
  }, [tools])

  // Re-weigh on a new tally; the ResizeObserver covers a pane drag, which changes no prop.
  useLayoutEffect(fit, [fit])
  /* v8 ignore start -- jsdom exposes no ResizeObserver. */
  useEffect(() => {
    const row = rowRef.current
    if (row === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(fit)
    observer.observe(row)
    return () => { observer.disconnect() }
  }, [fit])
  /* v8 ignore stop */

  const shownTools = tools.slice(0, shown)
  return (
    <div className="lc-ledger-chips lc-ledger-out-chips" ref={rowRef}>
      {shownTools.map(([name, n], i) => chip(name, n, i, onPick !== undefined))}
      <span className="lc-ledger-chip lc-ledger-chip-more">
        <i style={{ background: TOOL_REST }} />
        <span className="lc-ledger-chip-label">{t('stats.toolsMore', { n: tools.length - shown })}</span>
      </span>
      <span className="lc-ledger-gauge" aria-hidden="true">
        <div className="lc-ledger-chips" ref={gaugeRef}>{tools.map(([name, n], i) => chip(name, n, i))}</div>
        <div className="lc-ledger-chips" ref={chipGaugeRef}>
          {Array.from({ length: tools.length + 1 }, (_, k) => (
            <span key={k} className="lc-ledger-chip lc-ledger-chip-more">
              <i style={{ background: TOOL_REST }} />
              <span className="lc-ledger-chip-label">{t('stats.toolsMore', { n: k })}</span>
            </span>
          ))}
        </div>
      </span>
    </div>
  )
}

export function makeStatsContext(
  kit: ViewKit,
  useSubagentCost: (sessionId: string | undefined) => SubagentStats,
): (props: StatsContextProps) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: StatsContextProps): ReactElement {
    const ledger = props.spend ?? null
    const display = spendDisplayCurrency()
    const priced = ledger !== null && ledger.cost !== null
      ? {
        cost: ledger.cost,
        tokens: spendTokensOf(ledger),
        byModel: ledger.byModel,
        sessions: ledger.sessions,
        money: (value: number): string => formatSpendCost(value, ledger.currency, display, ledger.rates),
      }
      : null
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const { book, failed } = useModelPrices()
    const sub = useSubagentCost(props.sessionId)
    const subUsage = sub.usage
    const usage = mergeCostUsage(props.cost, subUsage) ?? undefined
    const cost = priced === null ? estimateSessionCost(usage, book, currency) : null
    const subCost = estimateSessionCost(subUsage, book, currency)
    const fmtRate = (usd: number): string => formatPriceRate(toCurrency(usd, currency), currency)
    const priceState = pricesOf(usage, book)
    const subPriceState = pricesOf(subUsage ?? undefined, book)
    const rows = priceState.rows
    const deepseek = usage !== undefined && Object.keys(usage).some(p => isDeepSeekProvider(p))
    const subDeepseek = subUsage !== null && Object.keys(subUsage).some(p => isDeepSeekProvider(p))
    const pricesBlock = (blocks: PriceRow[]): ReactNode =>
      blocks.length > 0 ? (
        <span key="prices" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">{t('stats.costPriceHead')}</span>
          {blocks.map(r => (
            <span key={r.key} className="lc-stat-tip-row">
              {BANDS.filter(([bucket]) => r.face.rate[bucket] > 0).map(([bucket, label]) => (
                <span key={bucket} className="lc-stat-tip-band">
                  <i>{t(label)}</i>
                  {' '}
                  <b>{fmtRate(r.face.rate[bucket])}</b>
                </span>
              ))}
              <span className="lc-stat-tip-by">{t('stats.costPriceBy', { p: r.face.pid, m: r.face.mid })}</span>
            </span>
          ))}
        </span>
      ) : null
    const missesBlock = (misses: PriceMissRow[]): ReactNode =>
      misses.length > 0 ? (
        <span key="misses" className="lc-stat-tip-prices">
          {misses.map(m => (
            <span key={m.key} className="lc-stat-tip-row">
              {m.miss.reason === 'ambiguous'
                ? t('stats.costAmbiguous', { p: m.provider, m: m.model, n: String(m.miss.candidates) })
                : t('stats.costNotListed', { p: m.provider, m: m.model })}
            </span>
          ))}
        </span>
      ) : null
    const inferredNote = (blocks: PriceRow[]): ReactNode =>
      blocks.some(r => r.face.via === 'canonical-maker' || r.face.via === 'family' || r.face.via === 'index')
        ? <span key="inferred">{t('stats.costInferredNote')}</span>
        : null
    const notes = (deep: boolean): ReactElement[] =>
      [
        currency === 'cny' ? <span key="cny">{t('stats.costTipCny')}</span> : null,
        deep ? <span key="peak">{t('stats.costTipDeepseek')}</span> : null,
      ].filter((el): el is ReactElement => el !== null)
    const tipFor = (state: { rows: PriceRow[]; misses: PriceMissRow[] }, scope: string, deep: boolean): ReactNode => [
      scope,
      <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
      pricesBlock(state.rows),
      missesBlock(state.misses),
      inferredNote(state.rows),
      ...notes(deep),
      failed ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    const costTip: ReactNode = priced !== null
      ? [
        t('stats.costTipLedger'),
        <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
        priced.sessions > 1 ? ' ' + t('stats.costTipTree', { n: priced.sessions }) : '',
        <span key="models" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">{t('stats.costModelHead')}</span>
          {priced.byModel.map(r => (
            <span key={`${r.provider ?? ''}/${r.model ?? ''}`} className="lc-stat-tip-row">
              <b className="lc-stat-tip-model">{r.model ?? '—'}</b>
              {' '}{priced.money(r.cost)}
              {' · '}{t('stats.costTokens', { n: fmt(spendTokensOf(r)) })}
            </span>
          ))}
        </span>,
      ]
      : tipFor(priceState, t('stats.costTip'), deepseek)
    const subTip: ReactNode = tipFor(subPriceState, t('stats.subCostTip'), subDeepseek)
    const ownPriceState = pricesOf(props.cost, book)
    const ownDeepseek = props.cost !== undefined && Object.keys(props.cost).some(p => isDeepSeekProvider(p))
    const ownTip: ReactNode = tipFor(ownPriceState, t('stats.ownCostTip'), ownDeepseek)
    const onJump = props.onJump
    const jumpWire = (key: StatsJump, hint = true): JumpWire | undefined => {
      const relay = onJump
      if (relay === undefined) return undefined
      return pickWire(hint ? t(JUMP_TIPS[key]) : undefined, () => { relay(key) })
    }
    const ioTotal = (props.humanInputs ?? 0) + props.files.reads + props.files.writes + props.files.searches + props.files.images
    // The head's live tally; the tally's own sum is the fallback on hosts too old to carry it.
    const toolTotal = props.toolCalls ?? props.tools.reduce((sum, [, n]) => sum + n, 0)
    const commandTop = props.commands?.top ?? []
    const chip = (
      key: string,
      label: string,
      value: number,
      color: string,
      opts: { title?: string; tip?: ReactNode; jump: StatsJump },
    ): ReactElement => {
      // A chip with its own ? bubble keeps the native title off: one hover target, one hint.
      const wire = jumpWire(opts.jump, opts.tip === undefined)
      return (
        <span
          key={key}
          className={'lc-ledger-chip'
            + (wire !== undefined ? ' lc-ledger-chip-btn' : '')
            + (value === 0 ? ' lc-ledger-chip-dim' : '')
            + (opts.tip !== undefined ? ' lc-stat-tipped group/tip' : '')}
          {...(wire ?? {})}
          title={opts.title}
        >
          <i style={{ background: color }} />
          <span className="lc-ledger-chip-label">
            {label}
            {opts.tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
          </span>
          <b>{fmt(value)}</b>
          {opts.tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{opts.tip}</span>}
        </span>
      )
    }
    const figure = (key: 'skills' | 'answers', value: number, label: string): ReactElement => {
      const wire = jumpWire(key)
      return (
        <span key={key} className={'lc-core-kv' + (wire === undefined ? '' : ' lc-core-kv-btn')} {...(wire ?? {})}>
          <b>{fmt(value)}</b>
          <i>{label}</i>
        </span>
      )
    }
    /** One lower-lane chip: the two lanes differ only in their dot colour, figures and pick wire. */
    const laneChip = (
      key: string,
      wire: JumpWire | undefined,
      opts: { color: string; label: string; count?: string; title: string },
    ): ReactElement => (
      <span
        key={key}
        className={'lc-ledger-chip' + (wire !== undefined ? ' lc-ledger-chip-btn' : '')}
        {...(wire ?? { title: opts.title })}
      >
        <i style={{ background: opts.color }} />
        <span className="lc-ledger-chip-label">{opts.label}</span>
        {opts.count !== undefined ? <b>{opts.count}</b> : null}
      </span>
    )
    /** An empty lower lane still holds one chip line, so the left and right stacks stay level. */
    const emptyChip = (key: string): ReactElement => (
      <span key={key} className="lc-ledger-chip lc-ledger-chip-dim">
        <span className="lc-ledger-chip-label">{t('stats.laneEmpty')}</span>
      </span>
    )
    const costPids = new Set(rows.map(r => r.face.pid).filter(p => p !== ''))
    const costHref = priced === null && costPids.size === 1 ? 'https://models.dev/providers/' + [...costPids][0] + '/' : undefined
    const ownCost = estimateSessionCost(props.cost, book, currency)
    const familyTokens = priced !== null ? priced.tokens : billedTokensOf(usage)
    const ownTokens = billedTokensOf(props.cost)
    const subTokens = billedTokensOf(subUsage)
    const pair = (tokens: number, costText: string): ReactElement => (
      <span className="lc-strip-pair"><b>{fmt(tokens)}</b><i>/</i><b>{costText}</b></span>
    )
    const costText = cost === null ? '—' : formatCost(cost, currency)
    const ownText = ownCost === null ? '—' : formatCost(ownCost, currency)
    const subText = subCost === null ? '—' : formatCost(subCost, currency)
    const teamPair = pair(familyTokens, priced !== null ? priced.money(priced.cost) : costText)
    const openTeam = props.onTeamClick
    const onTeamClick = (ev: MouseEvent): void => {
      if ((ev.target as HTMLElement).closest('a') !== null) return
      openTeam?.()
    }
    const onTeamKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      openTeam?.()
    }
    return (
      <div className="lc-card flex-[3] min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <div className="lc-stats">
          <div className="lc-ledger">
            <div className="lc-ledger-head lc-ledger-in-head">
              <span className="lc-ledger-label">{t('stats.io')}</span>
              <span className="lc-ledger-sep" aria-hidden="true">·</span>
              <b className="lc-ledger-total">{fmt(ioTotal)}</b>
            </div>
            <div className="lc-core">
              <span className="lc-core-label">{t('stats.session')}</span>
              <span className="lc-core-kvs lc-core-kvs-main">
                <span className="lc-core-kv lc-core-kv-lg"><b>{fmt(props.counts.steps)}</b><i>{t('stats.steps')}</i></span>
                <span className="lc-core-kv lc-core-kv-lg"><b>{fmt(props.counts.turns)}</b><i>{t('stats.turns')}</i></span>
              </span>
              <span className="lc-core-kvs">
                {figure('skills', props.counts.skills ?? 0, t('stats.skills'))}
                {figure('answers', props.answers ?? 0, t('stats.answers'))}
              </span>
            </div>
            <div className="lc-ledger-head lc-ledger-out-head">
              <span className="lc-ledger-label">{t('stats.toolCalls')}</span>
              <span className="lc-ledger-sep" aria-hidden="true">·</span>
              <b className="lc-ledger-total">{fmt(toolTotal)}</b>
            </div>
            <ToolChips tools={props.tools} onPick={props.onToolPick} t={t} fmt={fmt} />
            <div className="lc-ledger-head lc-ledger-in-head2">
              <span className="lc-ledger-label">{t('stats.commands')}</span>
              <span className="lc-ledger-sep" aria-hidden="true">·</span>
              <b className="lc-ledger-total">{fmt(props.commands?.runs ?? 0)}</b>
            </div>
            <div className="lc-ledger-head lc-ledger-out-head2">
              <span className="lc-ledger-label">{t('stats.subagents')}</span>
              <span className="lc-ledger-sep" aria-hidden="true">·</span>
              <b className="lc-ledger-total">{fmt(sub.count)}</b>
            </div>
            <div className="lc-ledger-chips lc-ledger-in-body2">
              {commandTop.length === 0
                ? emptyChip('in')
                : commandTop.map(([name, n]) => laneChip(name, props.onCommandPick !== undefined
                  ? pickWire(t('stats.commandJump'), () => { props.onCommandPick?.(name) })
                  : undefined, { color: TOOL_SHADE(1), label: name, count: fmt(n), title: name }))}
            </div>
            <div className="lc-ledger-chips lc-ledger-out-body2">
              {sub.members.length === 0
                ? emptyChip('out')
                : sub.members.slice(0, SUB_MEMBERS_MAX).map(m => laneChip(m.id, props.onMemberPick !== undefined
                  ? pickWire(m.label, () => { props.onMemberPick?.(m.id) })
                  : undefined, { color: familyHue(m.family), label: m.label, title: m.label }))}
              {sub.members.length > SUB_MEMBERS_MAX ? (
                <span className="lc-ledger-chip lc-ledger-chip-more" title={sub.members.slice(SUB_MEMBERS_MAX).map(m => m.label).join(' · ')}>
                  <i style={{ background: TOOL_REST }} />
                  <span className="lc-ledger-chip-label">{t('stats.membersMore', { n: sub.members.length - SUB_MEMBERS_MAX })}</span>
                </span>
              ) : null}
            </div>
            <div className="lc-ledger-chips lc-ledger-in-chips">
              {chip('inputs', t('stats.user'), props.humanInputs ?? 0, IO_COLOR.inputs, { jump: 'inputs', tip: t('stats.userTip') })}
              {chip('read', t('stats.fileRead'), props.files.reads, IO_COLOR.read, { jump: 'read', title: t('stats.filesJump') })}
              {chip('write', t('stats.fileWrite'), props.files.writes, IO_COLOR.write, { jump: 'write', title: t('stats.filesJump') })}
              {props.files.searches > 0 ? chip('search', t('stats.fileSearch'), props.files.searches, IO_COLOR.search, { jump: 'search', title: t('stats.filesJump') }) : null}
              {props.files.images > 0 ? chip('image', t('stats.fileImage'), props.files.images, IO_COLOR.image, { jump: 'image', title: t('stats.filesJump') }) : null}
            </div>
          </div>
          <div className="lc-strip">
            <div className="lc-strip-group">
              <span className="lc-strip-label">{t('stats.events')}</span>
              {EVENT_PILLS.map((p) => {
                const n = props.counts[p.tally]
                return (
                  <span key={p.kind} className={'lc-kind ' + p.cls + (n === 0 ? ' lc-ledger-chip-dim' : '')}>
                    {t('kind.' + p.kind)}
                    <b>{fmt(n)}</b>
                  </span>
                )
              })}
            </div>
            <div
              className="lc-strip-cost"
              role={openTeam === undefined ? undefined : 'button'}
              tabIndex={openTeam === undefined ? undefined : 0}
              onClick={openTeam === undefined ? undefined : onTeamClick}
              onKeyDown={openTeam === undefined ? undefined : onTeamKeyDown}
            >
              <span className="lc-strip-cell lc-stat-tipped group/tip">
                <i>
                  {t('stats.currentAgent')}
                  <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                </i>
                {pair(ownTokens, ownText)}
                <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{ownTip}</span>
              </span>
              <span className="lc-strip-cell lc-stat-tipped group/tip">
                <i>
                  {t('stats.teamSubs', { n: sub.count })}
                  <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                </i>
                {pair(subTokens, subText)}
                <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{subTip}</span>
              </span>
              <span className="lc-strip-cell lc-strip-team lc-stat-tipped group/tip">
                <i>
                  {t('stats.team')}
                  <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                </i>
                {costHref === undefined ? teamPair : <a className="lc-strip-link" href={costHref} target="_blank" rel="noreferrer noopener">{teamPair}</a>}
                <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{costTip}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
