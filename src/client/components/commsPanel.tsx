/** Fleet comms timeline. The harness attests traffic in three durable shapes the fleet-detail route lifts: a team relay
 * in the RECIPIENT's log (`agent-message`, sender id attested), a mailbox delivery (`team-message`, sender name
 * attested), and a child's settling account in the PARENT's log (`subagent-settled`). Scans run on demand (the N-log
 * read is expensive) and flag themselves stale once a scanned session moves on. */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { IconSendOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentNode } from '../agentTree'
import { commsStaleOf, type FleetDetailState } from '../fleetModel'
import { type CommsRow } from '../fleetDetail'
import { CommsParties, commsTextOf } from './commsRow'
import { fmtTime } from '../format'
import type { ViewKit } from '../viewkit'

export interface CommsPanelProps {
  nodes: readonly AgentNode[]
  details: FleetDetailState
  /** Merged comms rows, newest first. */
  comms: CommsRow[]
  labelOf: (id: string) => string
  onPin: (id: string | null) => void
  /** The shared agent pick (graph/members board): narrows the timeline; the toolbar's chip clears it. */
  pickId: string | null
  onPickClear: () => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

function clockOf(time: number): string {
  return time <= 0 ? '—' : fmtTime(time)
}

export function CommsPanel(props: CommsPanelProps): ReactElement {
  const { nodes, details, comms, pickId, t } = props
  const [agentFilter, setAgentFilter] = useState<string | null>(null)

  // A pick governs while it stands; the dropdown yields on landing and never resurrects after the pick clears.
  useEffect(() => {
    if (pickId !== null) setAgentFilter(null)
  }, [pickId])

  // Only scan-claimed sessions drive the panel: the inspector's own focus reads never flip it past collapsed.
  const scannedNodes = useMemo(() => nodes.filter(n => details.scanned.has(n.id)), [nodes, details.scanned])
  const done = scannedNodes.filter(n => details.landed.has(n.id)).length
  const scanning = scannedNodes.some(n => details.pending.has(n.id))
  const stale = useMemo(() => commsStaleOf(scannedNodes, details.landed), [scannedNodes, details.landed])

  const involved = useMemo(() => {
    const ids = new Set<string>()
    for (const row of comms) {
      if (row.from !== undefined) ids.add(row.from)
      ids.add(row.to)
    }
    return [...ids]
  }, [comms])

  // The pick narrows first; the dropdown governs only without one.
  const rows = pickId !== null
    ? comms.filter(row => row.from === pickId || row.to === pickId)
    : agentFilter !== null
      ? comms.filter(row => row.from === agentFilter || row.to === agentFilter)
      : comms

  const truncated = useMemo(() => {
    for (const entry of details.landed.values()) {
      if (entry.detail?.truncated === true) return true
    }
    return false
  }, [details.landed])

  return (
    <div className="lc-card lc-comms">
      <div className="lc-card-title">
        <span className="lc-card-title-text">
          <IconSendOutlineRegular size={14} />
          {t('fleet.comms.title')}
        </span>
        <span className="lc-card-sub">{t('fleet.comms.sub')}</span>
      </div>

      <div className="lc-fleet-toolbar">
        {details.scanned.size === 0 ? (
          <button
            type="button"
            className="lc-inspector-btn lc-comms-scan"
            onClick={() => { details.scan(nodes) }}
          >
            {t('fleet.comms.scan', { n: nodes.length })}
          </button>
        ) : (
          <>
            <span className="lc-agents-chip">
              {scanning
                ? t('fleet.comms.scanning', { done, total: details.scanned.size })
                : t('fleet.comms.rows', { n: comms.length })}
            </span>
            {stale && !scanning ? <span className="lc-agents-chip lc-agents-chip-on">{t('fleet.comms.stale')}</span> : null}
            <button type="button" className="lc-inspector-btn" onClick={() => { details.refresh(nodes) }}>
              {t('fleet.comms.rescan')}
            </button>
            {pickId !== null ? (
              <button
                type="button"
                className="lc-agents-badge lc-tasks-filter"
                title={props.labelOf(pickId)}
                onClick={props.onPickClear}
              >
                {props.labelOf(pickId)} ×
              </button>
            ) : involved.length > 0 ? (
              <select
                className="lc-fleet-sort"
                value={agentFilter ?? ''}
                aria-label={t('fleet.comms.filter')}
                onChange={(ev) => { setAgentFilter(ev.target.value === '' ? null : ev.target.value) }}
              >
                <option value="">{t('fleet.comms.all')}</option>
                {involved.map(id => <option key={id} value={id}>{props.labelOf(id)}</option>)}
              </select>
            ) : null}
          </>
        )}
      </div>

      {details.scanned.size > 0 && !scanning && comms.length === 0 ? (
        <div className="lc-empty">{t('fleet.comms.empty')}</div>
      ) : pickId !== null && !scanning && comms.length > 0 && rows.length === 0 ? (
        <div className="lc-empty">{t('fleet.comms.noMatch')}</div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="lc-comms-rows">
          {rows.map((row) => {
            const text = commsTextOf(row, t)
            return (
              <li key={row.key} className={`lc-comms-row lc-comms-${row.kind}`}>
                <span className="lc-comms-time">{clockOf(row.time)}</span>
                <span className="lc-agents-badge">{t(`fleet.kind.${row.kind}`)}</span>
                <span className="lc-comms-parties">
                  <CommsParties row={row} labelOf={props.labelOf} onPin={props.onPin} peerClass="lc-comms-peer" />
                </span>
                <span className="lc-comms-text" title={text !== row.text ? row.text : undefined}>
                  {text}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}

      {truncated ? <div className="lc-comms-note">{t('fleet.comms.truncated')}</div> : null}
    </div>
  )
}
