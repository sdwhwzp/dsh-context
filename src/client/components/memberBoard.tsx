/** The Fleet members board: the team's roster as full cards, then the family's other agents in the same form. The
 * toolbar's search/status/sort steer both sections; a pick pins the agent, a member's task chip filters the task board. */

import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { IconPanelLeftOutlineRegular, IconRightUpOutlineRegular, IconUserOutlineRegular, IconUsersOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentForest, AgentNode } from '../agentTree'
import { BRAND_HUE, familyHue, fmtDurationCompact, modelLabelOf } from '../agentTree'
import { familyOthersOf, tasksOfOwner, type FleetTeam } from '../fleetTeam'
import type { FleetDetail, FleetMemberInfo } from '../../shared/types'
import type { ViewKit } from '../viewkit'
import { ClearableInput } from './clearableInput'

export interface MemberBoardProps {
  /** Null when the session never composed the agent-team plugin — the panel still lists the family. */
  team: FleetTeam | null
  forest: AgentForest
  /** The lead session's landed fleet detail — the roster facts (duty descriptions) live there. */
  leadDetail: FleetDetail | null
  detailOf: (id: string) => { detail: FleetDetail | null } | undefined
  pinnedId: string | null
  /** Controlled hover (the graph's or task rows' hovered agent lifts its member card too). */
  hoverId?: string | null
  /** The card pick (click/keyboard) — reported raw; the parent owns the toggle and the
   * task-board narrowing (the graph's select semantics). */
  onPin: (id: string) => void
  onHover: (id: string | null) => void
  /** Enter the agent's session as the whole view, landing on this bundle's Context tab. */
  onEnter: (id: string) => void
  /** Open the agent in the sidebar aside; the parent keeps its own whole-view fallback. */
  onOpen: (id: string) => void
  /** The task board's owner filter, owned by the view so the boards interlock. */
  ownerFilter: string | null
  onOwnerFilter: (name: string | null) => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

/** One agent's hue shared by network, member and task cards: the lead carries the brand color, every other card a
 * golden-angled hue — teammates by roster order, other agents by their level-1 family (the graph's link hue). */
export function memberStyle(hue: string): CSSProperties {
  return { '--lc-member-hue': hue } as CSSProperties
}

export function runMetaOf(node: AgentNode, t: ViewKit['t']): string[] {
  const bits: string[] = []
  if (node.durationMs !== null) bits.push(fmtDurationCompact(node.durationMs))
  if (node.requests > 0) bits.push(t('agents.steps', { n: node.requests }))
  return bits
}

function memberMeta(node: AgentNode, t: ViewKit['t']): ReactElement | null {
  const bits = runMetaOf(node, t)
  if (bits.length === 0) return null
  return (
    <div className="lc-member-meta">
      <span className="lc-member-meta-text">{bits.join(' · ')}</span>
    </div>
  )
}

type StatusFilter = 'all' | 'running' | 'done' | 'idle'
type SortKey = 'spawn' | 'tokens' | 'duration' | 'steps' | 'recent'

function statusOf(node: AgentNode): Exclude<StatusFilter, 'all'> {
  if (node.running) return 'running'
  return node.completed ? 'done' : 'idle'
}

const SORTERS: Record<Exclude<SortKey, 'spawn'>, (a: AgentNode, b: AgentNode) => number> = {
  tokens: (a, b) => (b.head?.tokens ?? 0) - (a.head?.tokens ?? 0),
  duration: (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0),
  steps: (a, b) => b.requests - a.requests,
  recent: (a, b) => b.updatedAt - a.updatedAt,
}

export function MemberBoard(props: MemberBoardProps): ReactElement {
  const { team, forest, t, fmt } = props
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('spawn')

  const nodeById = useMemo(() => new Map(forest.nodes.map(n => [n.id, n])), [forest])
  const roster = new Map<string, FleetMemberInfo>()
  for (const info of props.leadDetail?.roster ?? []) roster.set(info.name, info)

  // The other-agents section: family nodes outside the team roster, minus the current session
  // (its own card already headlines the network graph).
  const othersAll = useMemo(() => familyOthersOf(forest, team), [forest, team])
  const others = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const out = othersAll.filter((node) => {
      if (status !== 'all' && statusOf(node) !== status) return false
      if (needle !== '' && !node.label.toLowerCase().includes(needle) && !node.id.toLowerCase().includes(needle)) return false
      return true
    })
    // Spawn order is the forest's own DFS order — the parent catalog's own sibling sequence.
    return sort === 'spawn' ? out : [...out].sort(SORTERS[sort])
  }, [othersAll, query, status, sort])

  // The toolbar steers the member cards too: search by member name, status by their node's state
  // (a member whose session left the list reads as idle).
  const members = useMemo(() => {
    if (team === null) return []
    const needle = query.trim().toLowerCase()
    return team.members.filter((member) => {
      if (needle !== '' && !member.name.toLowerCase().includes(needle)) return false
      if (status === 'all') return true
      const node = nodeById.get(member.id)
      return node === undefined ? status === 'idle' : statusOf(node) === status
    })
  }, [team, query, status, nodeById])

  const counts = useMemo(() => {
    const c = { all: 0, running: 0, done: 0, idle: 0 }
    for (const n of forest.nodes) {
      if (n.isCurrent) continue
      c.all++
      c[statusOf(n)]++
    }
    return c
  }, [forest])

  // The toolbar earns its keep only with at least two entries to sift; a filtered-empty board keeps it so the reader
  // can back out of the filter.
  const listTotal = (team?.members.length ?? 0) + othersAll.length
  const bare = query === '' && status === 'all'

  const opens = (id: string): ReactElement => (
    <span className="lc-member-opens">
      <button
        type="button"
        className="lc-inspector-btn lc-member-aside"
        title={t('fleet.openSidebar')}
        onClick={(ev) => {
          ev.stopPropagation()
          props.onOpen(id)
        }}
      >
        <IconPanelLeftOutlineRegular size={11} />
      </button>
      <button
        type="button"
        className="lc-inspector-btn lc-member-enter"
        title={t('fleet.open')}
        onClick={(ev) => {
          ev.stopPropagation()
          props.onEnter(id)
        }}
      >
        <IconRightUpOutlineRegular size={11} />
      </button>
    </span>
  )

  return (
    <div className="lc-card lc-members">
      <div className="lc-card-title">
        <span className="lc-card-title-text">
          <IconUsersOutlineRegular size={14} />
          {t('fleet.board.title')}
        </span>
        <span className="lc-agents-chip">{t('agents.chip.count', { n: forest.nodes.length })}</span>
        {team?.failure !== undefined ? (
          <span className="lc-agents-badge lc-agents-badge-err" title={team.failure}>{t('fleet.team.failureShort')}</span>
        ) : null}
      </div>

      {listTotal > 1 || !bare ? (
        <div className="lc-fleet-toolbar">
          <ClearableInput
            type="search"
            className="lc-fleet-search"
            placeholder={t('fleet.list.search')}
            clearLabel={t('field.clear')}
            value={query}
            onChange={setQuery}
          />
          <div className="lc-fleet-filters" role="group" aria-label={t('fleet.list.filter')}>
            {(['all', 'running', 'done', 'idle'] as const).map(key => (
              <button
                key={key}
                type="button"
                className={'lc-gran-btn' + (status === key ? ' lc-gran-on' : '')}
                onClick={() => { setStatus(key) }}
              >
                {t(`fleet.filter.${key}`)}
                <span className="lc-kind-n">{fmt(counts[key])}</span>
              </button>
            ))}
          </div>
          <select
            className="lc-fleet-sort"
            value={sort}
            aria-label={t('fleet.list.sort')}
            onChange={(ev) => { setSort(ev.target.value as SortKey) }}
          >
            {(['spawn', 'tokens', 'duration', 'steps', 'recent'] as const).map(key => (
              <option key={key} value={key}>{t(`fleet.sort.${key}`)}</option>
            ))}
          </select>
        </div>
      ) : null}

      {team !== null && members.length > 0 ? (
        <>
          <div className="lc-board-section-head">
            {t('fleet.members.title')}
            <span className="lc-kind-n">{fmt(members.length)}</span>
          </div>
          <div className="lc-members-grid">
            {members.map((member) => {
              const node = nodeById.get(member.id)
              const running = node?.running === true
              const info = roster.get(member.name)
              const detail = props.detailOf(member.id)?.detail ?? null
              const model = node?.model !== undefined
                ? modelLabelOf(node.model, node.reasoningEffort)
                : modelLabelOf(detail?.descriptor?.agentModel, detail?.descriptor?.agentReasoningEffort)
              const owned = tasksOfOwner(team, member.name)
              const activeTasks = owned.filter(task => task.status !== 'completed')
              const isCurrent = node?.isCurrent === true
              return (
                <div
                  key={member.id}
                  className={
                    'lc-member-card'
                      + (props.pinnedId === member.id ? ' lc-member-pinned' : '')
                      + (props.hoverId === member.id ? ' lc-member-hover' : '')
                      + (member.phase === 'failed' ? ' lc-member-failed' : '')
                  }
                  style={memberStyle(member.role === 'lead' ? BRAND_HUE : familyHue(team.members.indexOf(member)))}
                  role="button"
                  tabIndex={0}
                  aria-pressed={props.pinnedId === member.id}
                  onClick={() => { props.onPin(member.id) }}
                  onKeyDown={(ev) => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return
                    ev.preventDefault()
                    props.onPin(member.id)
                  }}
                  onMouseEnter={() => { props.onHover(member.id) }}
                  onMouseLeave={() => { props.onHover(null) }}
                >
                  <div className="lc-member-head">
                    <span className="lc-member-icon">
                      {member.role === 'lead' ? <IconUsersOutlineRegular size={13} /> : <IconUserOutlineRegular size={13} />}
                    </span>
                    <b className="lc-member-name">{member.name}</b>
                    {isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
                    <span className="lc-agents-badge">{t(member.role === 'lead' ? 'fleet.role.lead' : 'fleet.role.teammate')}</span>
                    <StateDot
                      state={member.phase === 'failed' ? 'error' : member.phase === 'provisioning' || running ? 'ongoing' : 'idle'}
                      size={9}
                      className="lc-member-dot"
                    />
                  </div>
                  <div className="lc-member-status">
                    {member.phase === 'failed'
                      ? t('fleet.phase.failed')
                      : member.phase === 'provisioning'
                        ? t('fleet.phase.provisioning')
                        : running ? t('agents.running') : t('fleet.memberInactive')}
                    {model !== undefined ? <span className="lc-member-model">{model}</span> : null}
                  </div>
                  {member.error !== undefined ? <div className="lc-inspector-error">{member.error}</div> : null}
                  {info !== undefined && info.description !== '' ? (
                    <div className="lc-member-desc" title={info.description}>{info.description}</div>
                  ) : null}
                  {detail?.lastReply !== undefined ? (
                    <div className="lc-member-reply" title={detail.lastReply.text}>
                      {t('fleet.members.reply')} {detail.lastReply.text}
                    </div>
                  ) : null}
                  <div className="lc-member-foot">
                    {node !== undefined ? memberMeta(node, t) : null}
                    {activeTasks.length > 0 ? (
                      <button
                        type="button"
                        className={'lc-member-tasks' + (props.ownerFilter === member.name ? ' lc-member-tasks-on' : '')}
                        title={t('fleet.members.tasksTip')}
                        onClick={(ev) => {
                          ev.stopPropagation()
                          props.onOwnerFilter(props.ownerFilter === member.name ? null : member.name)
                        }}
                      >
                        {t('fleet.members.tasks', { n: activeTasks.length })}
                      </button>
                    ) : <span className="lc-member-tasks-none">{t('fleet.members.noTasks')}</span>}
                    {!isCurrent && node !== undefined ? opens(member.id) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      {team === null && forest.solo ? (
        <div className="lc-empty">{t('fleet.board.solo')}</div>
      ) : null}
      {team === null && !forest.solo ? (
        <div className="lc-members-note">{t('fleet.board.noTeam')}</div>
      ) : null}

      {others.length > 0 ? (
        <>
          <div className="lc-board-section-head">
            {t('fleet.board.others')}
            <span className="lc-kind-n">{fmt(others.length)}</span>
          </div>
          <div className="lc-members-grid">
            {others.map((node) => {
              const detail = props.detailOf(node.id)?.detail ?? null
              const model = modelLabelOf(node.model, node.reasoningEffort)
              return (
                <div
                  key={node.id}
                  className={
                    'lc-member-card'
                      + (props.pinnedId === node.id ? ' lc-member-pinned' : '')
                      + (props.hoverId === node.id ? ' lc-member-hover' : '')
                  }
                  style={memberStyle(familyHue(node.family))}
                  role="button"
                  tabIndex={0}
                  aria-pressed={props.pinnedId === node.id}
                  onClick={() => { props.onPin(node.id) }}
                  onKeyDown={(ev) => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return
                    ev.preventDefault()
                    props.onPin(node.id)
                  }}
                  onMouseEnter={() => { props.onHover(node.id) }}
                  onMouseLeave={() => { props.onHover(null) }}
                >
                  <div className="lc-member-head">
                    <span className="lc-member-icon">
                      <IconUserOutlineRegular size={13} />
                    </span>
                    {/* A subagent's prompt title IS its identity and runs long: two clamped lines where a roster name is one. */}
                    <b className="lc-member-name lc-member-name-wrap" title={node.label}>{node.label}</b>
                    <StateDot
                      state={node.running ? 'ongoing' : node.completed ? 'done' : 'idle'}
                      size={9}
                      className="lc-member-dot"
                    />
                  </div>
                  <div className="lc-member-status">
                    {node.running ? t('agents.running') : node.completed ? t('fleet.filter.done') : t('fleet.memberInactive')}
                    {model !== undefined ? <span className="lc-member-model">{model}</span> : null}
                  </div>
                  {detail?.lastReply !== undefined ? (
                    <div className="lc-member-reply" title={detail.lastReply.text}>
                      {t('fleet.members.reply')} {detail.lastReply.text}
                    </div>
                  ) : null}
                  <div className="lc-member-foot">
                    {memberMeta(node, t)}
                    {opens(node.id)}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      {!bare && members.length === 0 && others.length === 0 ? <div className="lc-empty">{t('fleet.list.empty')}</div> : null}
    </div>
  )
}
