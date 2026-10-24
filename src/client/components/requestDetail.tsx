import { memo, type ComponentType, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { partsOf, CATS } from '../categories'
import { cacheHitPercent } from '../format'
import type { StepBrief } from '../brief'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import type { ConversationNodeLike } from '../services'
import type { StackedBarProps, LegendProps } from './stackedBar'
import type { ViewKit } from '../viewkit'

export interface RequestDetailProps {
  request: RequestRecord | null
  /** The previous record (null on the first bar); its PRESENCE switches the panel to the signed delta. */
  prev?: RequestRecord | null
  marker?: ContextEventRecord | null
  /** Step identity (see brief.ts); null renders the empty reserved lane. */
  brief?: StepBrief | null
  /** Snapshot join for call-argument enrichment; absent join = names only, never an error. */
  convOf?: (seq: number) => ConversationNodeLike | undefined
  /** Per-turn step totals; absent = a 1-step turn. */
  stepsOf?: (turn: number | undefined) => number
  /** Reveal a brief row's node in the browser; absent = rows render inert. */
  onLocate?: (node: SurfaceNode, isResponse: boolean) => void
  /** Category hover shared with the overview/browser; chips report hovers back, the bar never does. */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function makeRequestDetail(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  Legend: (props: LegendProps) => ReactElement,
): ComponentType<RequestDetailProps> {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit

  /** The tag carries the styled bubble, the content span the native title — the two never stack. */
  function BriefRow(props: {
    tag: string
    tagTip: string
    node?: SurfaceNode
    isResponse: boolean
    onLocate?: (node: SurfaceNode, isResponse: boolean) => void
    children: ReactNode
  }): ReactElement {
    const inner = (
      <>
        <span className="lc-brief-tag group/tip">
          {props.tag}
          <span className="lc-tip lc-brief-tip group-hover/tip:opacity-100" role="tooltip">{props.tagTip}</span>
        </span>
        {props.children}
      </>
    )
    if (props.node === undefined || props.onLocate === undefined) return <div className="lc-brief-row">{inner}</div>
    const node = props.node
    const onLocate = props.onLocate
    const locate = (): void => { onLocate(node, props.isResponse) }
    return (
      <button type="button" className="lc-brief-row lc-brief-row-link hover:bg-(--dsw-alias-interactive-bg-hover)" onClick={locate}>
        {inner}
      </button>
    )
  }

  /** A hostile `cat` degrades into the user tail — a plain text row, never a throw. */
  function chipParts(n: SurfaceNode, conv: ConversationNodeLike | undefined): { tag: string | null; text: string } {
    if (n.cat === 'tool') {
      const summary = callSummaryOf(conv)
      if (n.tool !== undefined) return { tag: n.tool, text: summary ?? '' }
      return { tag: null, text: summary ?? t('node.toolResult') }
    }
    if (n.cat === 'skill') {
      // A load/invocation tags its NAME, the catalog digest its form label; a text-less row previews the call summary.
      return {
        tag: n.skill !== undefined ? t('node.skillTag', { name: n.skill }) : t('form.' + (n.form ?? 'context')),
        text: n.text ?? callSummaryOf(conv) ?? '',
      }
    }
    if (n.cat === 'assistant') {
      // The fold keeps `calls` only for TEXT-LESS replies; a reply with both recovers its breadcrumb via the join.
      const names = n.calls !== undefined && n.calls.length > 0 ? n.calls : callNamesOf(conv)
      const own = n.text !== undefined && n.text !== '' ? n.text : blockSummaryOf(conv) ?? ''
      return {
        tag: names.length > 0 ? names.join(' › ') : null,
        text: own !== '' ? own : (names.length > 0 ? '' : t('node.empty')),
      }
    }
    if (n.cat === 'inject') {
      const text = n.text !== undefined && n.text !== ''
        ? (n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text)
        : ''
      return { tag: t('form.' + (n.form ?? 'context')), text }
    }
    const imgs = n.imgs ?? 0
    return {
      tag: imgs > 0 ? t('attach.image') + (imgs > 1 ? ' ×' + String(imgs) : '') : null,
      text: n.text ?? '',
    }
  }

  function factTitle(tag: string | null, text: string): string {
    return tag !== null ? (text !== '' ? tag + ' · ' + text : tag) : text
  }

  /** Always renders a fixed three-row lane so scrubbing the chart never changes the panel's height. */
  function BriefSection(props: {
    brief: StepBrief | null | undefined
    convOf?: (seq: number) => ConversationNodeLike | undefined
    onLocate?: (node: SurfaceNode, isResponse: boolean) => void
  }): ReactElement {
    const { opener, inputs, response } = props.brief ?? { inputs: [] }
    const convOf = props.convOf ?? (() => undefined)
    const hint = props.onLocate !== undefined ? ' — ' + t('brief.locate') : ''
    // Chip click locates its own node; stopPropagation keeps the row's locate from also firing.
    const locateChip = props.onLocate === undefined ? undefined : (n: SurfaceNode) =>
      (e?: MouseEvent) => { e?.stopPropagation(); props.onLocate?.(n, false) }
    const MAX_CHIPS = 3
    /** Reply chip is grown and inert; the row button locates it. */
    const nodeChip = (n: SurfaceNode, onClick?: (e?: MouseEvent) => void, grow = false): ReactElement => {
      const { tag, text } = chipParts(n, convOf(n.seq))
      return (
        <span
          key={n.seq}
          className={'lc-brief-chip' + (grow ? ' lc-brief-chip-grow' : '') + (onClick !== undefined ? ' lc-brief-chip-link hover:bg-(--dsw-alias-interactive-bg-hover)' : '')}
          title={factTitle(tag, text) + hint}
          onClick={onClick}
        >
          {n.err === true ? <span className="lc-br-err-dot" /> : null}
          {tag !== null ? <span className="lc-brief-chip-tag">{tag}</span> : null}
          {text !== '' ? <span className="lc-brief-chip-text">{text}</span> : null}
        </span>
      )
    }
    const openerParts = opener !== undefined ? chipParts(opener, convOf(opener.seq)) : null
    return (
      <div className="lc-brief">
        {opener !== undefined && openerParts !== null ? (
          <BriefRow tag={t('brief.turn')} tagTip={t('brief.turnTip')} node={opener} isResponse={false} onLocate={props.onLocate}>
            {openerParts.tag !== null ? <span className="lc-brief-fact">{openerParts.tag}</span> : null}
            {openerParts.text !== '' ? (
              <span className="lc-brief-text" title={factTitle(openerParts.tag, openerParts.text) + hint}>{openerParts.text}</span>
            ) : null}
          </BriefRow>
        ) : null}
        <BriefRow tag={t('brief.input')} tagTip={t('brief.inputTip')} node={inputs[0]} isResponse={false} onLocate={props.onLocate}>
          {inputs.length > 0 ? (
            <>
              {inputs.slice(0, MAX_CHIPS).map(n => nodeChip(n, locateChip?.(n)))}
              {inputs.length > MAX_CHIPS ? <span className="lc-brief-more">{t('brief.more', { n: inputs.length - MAX_CHIPS })}</span> : null}
            </>
          ) : (
            <span className="lc-brief-empty">{t('brief.noInputs')}</span>
          )}
        </BriefRow>
        {response !== undefined ? (
          <BriefRow tag={t('brief.reply')} tagTip={t('brief.replyTip')} node={response} isResponse onLocate={props.onLocate}>
            {nodeChip(response, undefined, true)}
          </BriefRow>
        ) : null}
      </div>
    )
  }

  // Memoized at the factory level: the parent hands reference-stable props across hover/select renders (see contextView),
  // so the panel skips reconciliation when the active bar did not move.
  return memo(function RequestDetail(props: RequestDetailProps): ReactElement | null {
    // The memo must not block a locale switch: the tick re-renders on it even when the props are reference-stable.
    kit.useLocaleTick()
    const req = props.request
    if (!req) return null
    const isTurn = req.stepCount !== undefined && req.stepCount > 1
    const head = isTurn
      ? t('detail.turn', {
        t: req.turn ?? 0,
        /** v8 ignore next -- isTurn already guarantees stepCount !== undefined; the fallback is defensive. */
        n: req.stepCount ?? 0,
      })
      : t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0, n: props.stepsOf?.(req.turn) ?? 1 })
    // A boundary-event bar also shows WHERE it happened: the gap between the requests before and after.
    const marker = props.marker ?? null
    const markerAt = marker !== null ? eventAt(marker) : null
    // Delta mode: per-category signed change vs the previous record; provider usage chips drop out (per-request figures).
    const delta = props.prev !== undefined
    const prev = props.prev ?? null
    const deltas = CATS.map(c => delta ? (req[c.key] || 0) - (prev !== null ? prev[c.key] || 0 : 0) : 0)
    let net = 0
    if (delta) {
      for (const d of deltas) net += d
    }
    const parts = delta
      ? CATS.map((c, i) => ({ key: c.key, color: c.color, value: Math.abs(deltas[i]) }))
      : partsOf(req)
    // Delta chips print the signed change; the bar's own parts keep only magnitudes.
    const legendParts = delta ? parts.map((p, i) => ({ ...p, raw: deltas[i] })) : parts
    return (
      <div className="lc-detail">
        <div className="lc-detail-head">
          <b>{head}</b>
          {marker !== null && markerAt !== null
            ? <span className="lc-detail-marker" title={eventLabel(marker)}>{'✂ ' + markerAt}</span>
            : null}
          {isTurn ? <span className="lc-detail-tag">{t('detail.lastStep')}</span> : null}
          {delta ? <span className="lc-detail-tag">{t('gran.delta')}</span> : null}
          <span className="lc-detail-time">{fmtTime(req.time)}</span>
          {/* One neutral pill per provider figure; the cache pill drops out on hosts that don't fold `cacheRead`.
              The chips share a row of their own (`flex-basis: 100%`) so the header height stays constant. */}
          <span className="lc-detail-metrics">
            {delta ? (
              <span className={'lc-detail-metric' + (net > 0 ? ' lc-detail-metric-up' : net < 0 ? ' lc-detail-metric-down' : '')}>
                {t('tip.delta', { n: (net > 0 ? '+' : '') + fmt(net) })}
              </span>
            ) : null}
            {!delta && req.prompt !== undefined
              ? <span className="lc-detail-metric">{t('detail.actual', { n: fmt(req.prompt) })}</span>
              : null}
            {!delta && req.output !== undefined
              ? <span className="lc-detail-metric">{t('detail.output', { n: fmt(req.output) })}</span>
              : null}
            {!delta && req.prompt !== undefined && req.cacheRead !== undefined
              ? <span className="lc-detail-metric">{t('detail.cache', { n: cacheHitPercent(req.cacheRead, req.prompt) ?? '—' })}</span>
              : null}
          </span>
        </div>
        <BriefSection brief={props.brief} convOf={props.convOf} onLocate={props.onLocate} />
        <StackedBar parts={parts} height={10} hoverKey={props.hoverKey} tip={false} />
        <Legend parts={legendParts} hoverKey={props.hoverKey} onHoverKey={props.onHoverKey} delta={delta} />
      </div>
    )
  })
}
