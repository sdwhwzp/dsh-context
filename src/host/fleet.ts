import type { Context } from '@deepseek-ai/cordis'
import type {
  FleetBatchRequest,
  FleetBatchValue,
  FleetDelegation,
  FleetDescriptor,
  FleetDetail,
  FleetDetailCounts,
  FleetMemberInfo,
  FleetMessage,
  FleetSummary,
  FleetSummaryMember,
} from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { AccountAccessUnavailableError, canReadAccountSession, isAccountRequest, readableAccountSessions } from './connection'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply, revisionOf, routeFailure } from './postRoute'
import { makeFoldCache, type FoldCache } from './foldCache'
import { asRecord } from './record'
import { serviceIdentityOf } from './serviceIdentity'

export const FLEET_ROUTE = '/api/dsh-context/fleet'

const MESSAGES_MAX = 80
const MESSAGE_TEXT_MAX = 400
const PROMPT_TEXT_MAX = 1600
const REPLY_TEXT_MAX = 300
const BATCH_MAX = 16

function detailModeOf(body: unknown): FleetDetailMode {
  if (asRecord(body)?.full === true) return 'full'
  return asRecord(body)?.history === true ? 'history' : 'preview'
}

function textBlocksOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    const text = asRecord(block)?.text
    if (typeof text === 'string') out.push(text)
  }
  return out
}

function textOfContent(content: unknown): string {
  return textBlocksOf(content).join('')
}

/** A teammate briefing opens with an injected `<system-reminder>` framing block; the excerpt drops it. */
const REMINDER_PREFIX = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max) + '…', cut: true } : { text, cut: false }
}

function descriptorOf(data: Record<string, unknown>): FleetDescriptor | null {
  const mode = data.mode
  if (mode !== 'one-shot' && mode !== 'continuable') return null
  const out: FleetDescriptor = { mode }
  for (const key of ['label', 'provider', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

const MAILBOX_PREFIX = /^Team message \S+ from ([^:]{1,64}):\s*/
const RELAY_PREFIX = /^(?:Agent \S+ sent a message: |Team message from ([^:\n]{1,64}):\s*)/

const CLOSING_HEAD = 'Its closing message:'
const NO_CLOSING = 'It left no closing message.'
const CLOSING_OMITTED = 'It sent you a message just before finishing, so its closing message is omitted.'
const STRUCTURED_HEAD = 'Structured result: '

function jsonSpan(text: string): number {
  const first = text[0]
  if (first !== '{' && first !== '[') return 0
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

interface SettledFields {
  summary: string
  report?: string
  structured?: string
  diagnostic?: string
  clipped: boolean
}

function structuredBlockOf(blocks: readonly string[]): number {
  // The closing marker guarantees at least one child-authored block before optional runtime metadata.
  const first = blocks[1] === CLOSING_HEAD ? 3 : 2
  for (let i = blocks.length - 1; i >= first; i--) {
    const block = blocks[i]
    if (!block.startsWith(STRUCTURED_HEAD)) continue
    try { JSON.parse(block.slice(STRUCTURED_HEAD.length)) }
    catch { continue } // A literal marker in closing prose is not a structured result.
    return i
  }
  return -1
}

/** Split the runtime notice into its summary, closing report, structured result, and trailing diagnostic. */
function settledFields(summary: string, text: string, max: number, blocks: readonly string[]): SettledFields {
  let clipped = false
  const put = (value: string): string | undefined => {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const cut = clip(trimmed, max)
    if (cut.cut) clipped = true
    return cut.text
  }
  const framed = blocks.length > 1 && blocks[0].trim() === summary
  const rest = text.slice(summary.length).trim()
  const structuredAt = framed ? structuredBlockOf(blocks) : rest.indexOf(STRUCTURED_HEAD)
  let before = framed
    ? blocks.slice(1, structuredAt >= 0 ? structuredAt : undefined).join('').trim()
    : structuredAt >= 0 ? rest.slice(0, structuredAt).trim() : rest
  if (before === NO_CLOSING || before === CLOSING_OMITTED) before = ''
  else if (before.startsWith(CLOSING_HEAD)) before = before.slice(CLOSING_HEAD.length).trim()
  let structured: string | undefined
  let diagnostic: string | undefined
  if (structuredAt >= 0) {
    if (framed) {
      structured = put(blocks[structuredAt].slice(STRUCTURED_HEAD.length))
      diagnostic = put(blocks.slice(structuredAt + 1).join(''))
    } else {
      const raw = rest.slice(structuredAt + STRUCTURED_HEAD.length).trim()
      const end = jsonSpan(raw)
      structured = put(end > 0 ? raw.slice(0, end) : raw)
      if (end > 0) diagnostic = put(raw.slice(end))
    }
  }
  const summaryCut = clip(summary, max)
  if (summaryCut.cut) clipped = true
  const report = put(before)
  const out: SettledFields = { summary: summaryCut.text, clipped }
  if (report !== undefined) out.report = report
  if (structured !== undefined) out.structured = structured
  if (diagnostic !== undefined) out.diagnostic = diagnostic
  return out
}

function messageOf(seq: number, time: number, data: Record<string, unknown>, max: number): FleetMessage | null {
  const source = asRecord(data.source)
  const kind = source?.kind
  let message: FleetMessage | null = null
  if (kind === 'agent-message' || kind === 'team-message') {
    const raw = textOfContent(data.content)
    const prefix = kind === 'team-message' ? MAILBOX_PREFIX : RELAY_PREFIX
    const framed = prefix.exec(raw)
    const text = raw.replace(prefix, '')
    if (text.trim() === '') return null
    message = {
      seq,
      time,
      kind: kind === 'agent-message' ? 'relay' : 'mailbox',
      text,
    }
    const from = kind === 'agent-message' ? source?.senderSessionId : source?.senderId
    if (typeof from === 'string' && from !== '') message.from = from
    const fromName = typeof source?.senderName === 'string' && source.senderName !== ''
      ? source.senderName
      : framed?.[1]
    if (fromName !== undefined && fromName !== '') message.fromName = fromName
  } else if (kind === 'subagent-settled') {
    const summary = typeof source?.summary === 'string' ? source.summary.trim() : ''
    const content = textOfContent(data.content).trim()
    const text = summary !== '' && !content.startsWith(summary)
      ? summary
      : content !== '' ? content : summary
    if (text.trim() === '') return null
    message = { seq, time, kind: 'settled', text }
    const from = source?.senderSessionId
    if (typeof from === 'string' && from !== '') message.from = from
    if (summary !== '') {
      const fields = settledFields(summary, text, max, textBlocksOf(data.content))
      message.summary = fields.summary
      if (fields.clipped) message.clipped = true
      if (fields.report !== undefined) message.report = fields.report
      if (fields.structured !== undefined) message.structured = fields.structured
      if (fields.diagnostic !== undefined) message.diagnostic = fields.diagnostic
    }
  }
  if (message === null) return null
  const cut = clip(message.text, max)
  message.text = cut.text
  if (cut.cut) message.clipped = true
  return message
}

function isPlainPrompt(source: Record<string, unknown> | null): boolean {
  if (source === null) return true
  return source.kind === 'user'
}

function rosterMemberOf(data: Record<string, unknown>): FleetMemberInfo | null {
  const member = asRecord(data.member)
  if (member === null) return null
  if (typeof member.name !== 'string' || member.name === '') return null
  const out: FleetMemberInfo = {
    name: member.name,
    description: typeof member.description === 'string' ? member.description : '',
  }
  if (typeof member.provider === 'string' && member.provider !== '') out.provider = member.provider
  if (member.context === 'fresh' || member.context === 'fork') out.context = member.context
  return out
}

function delegationOf(seq: number, data: Record<string, unknown>): FleetDelegation | null {
  if (typeof data.childId !== 'string' || data.childId === '') return null
  if (typeof data.childCreatedAt !== 'number' || !Number.isFinite(data.childCreatedAt)) return null
  const mode = data.mode
  if (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'external' && mode !== 'unknown') return null
  if (mode === 'continuable' && (typeof data.label !== 'string' || data.label === '')) return null
  return {
    seq,
    time: data.childCreatedAt,
    to: data.childId,
    mode,
    ...(typeof data.label === 'string' && data.label !== '' ? { label: data.label } : {}),
  }
}

function teamDelegationOf(seq: number, time: number, data: Record<string, unknown>): FleetDelegation | null {
  const member = asRecord(data.member)
  if (member === null || member.phase !== 'active') return null
  if (typeof member.id !== 'string' || member.id === '' || member.id === data.teamId) return null
  return {
    seq,
    time,
    to: member.id,
    mode: 'continuable',
    ...(typeof member.description === 'string' && member.description !== '' ? { label: member.description } : {}),
  }
}

function linkedSessionOf(entry: unknown): string | null | undefined {
  const event = asRecord(entry)
  const data = asRecord(event?.data)
  let id: unknown
  switch (event?.type) {
    case 'subagent/catalog':
      id = data?.childId
      break
    case 'team/member':
      id = asRecord(data?.member)?.id
      break
    case 'user/message': {
      const source = asRecord(data?.source)
      if (source?.kind === 'team-message') id = source.senderId
      else if (source?.kind === 'agent-message' || source?.kind === 'subagent-settled') id = source.senderSessionId
      else return undefined
      break
    }
    default:
      return undefined
  }
  return typeof id === 'string' && id !== '' ? id : null
}

type FleetDetailMode = 'preview' | 'history' | 'full'

interface FleetCaps {
  promptMax: number
  replyMax: number
  messageMax: number
  listMax: number
}

function capsOf(mode: FleetDetailMode): FleetCaps {
  if (mode === 'full') {
    return {
      promptMax: Number.POSITIVE_INFINITY,
      replyMax: Number.POSITIVE_INFINITY,
      messageMax: Number.POSITIVE_INFINITY,
      listMax: Number.POSITIVE_INFINITY,
    }
  }
  if (mode === 'history') {
    return { promptMax: PROMPT_TEXT_MAX, replyMax: REPLY_TEXT_MAX, messageMax: MESSAGE_TEXT_MAX, listMax: Number.POSITIVE_INFINITY }
  }
  return { promptMax: PROMPT_TEXT_MAX, replyMax: REPLY_TEXT_MAX, messageMax: MESSAGE_TEXT_MAX, listMax: MESSAGES_MAX }
}

type MemberFact = FleetSummaryMember & { createdAt: number }

class FleetFold {
  private descriptor: FleetDescriptor | undefined
  private initialPrompt: string | undefined
  private truncated = false
  private total = 0
  private readonly messages: FleetMessage[] = []
  private readonly delegationAt = new Map<string, FleetDelegation>()
  private readonly roster = new Map<string, FleetMemberInfo>()
  private readonly catalogFacts = new Map<string, MemberFact>()
  private readonly teamFacts = new Map<string, MemberFact>()
  private lastReply: { time: number; text: string } | null = null

  constructor(private readonly caps: FleetCaps) {}

  private memberFactOf(id: string, name: string | undefined, createdAt: number): MemberFact {
    return { id, createdAt, ...(name === undefined ? {} : { name }) }
  }

  private catalogMemberOf(seq: number, data: Record<string, unknown>): void {
    const delegation = delegationOf(seq, data)
    if (delegation === null) return
    const name = typeof data.name === 'string' && data.name !== '' ? data.name : undefined
    const fact = this.memberFactOf(delegation.to, name, delegation.time)
    this.catalogFacts.set(fact.id, {
      ...fact,
      mode: delegation.mode,
      ...(delegation.label !== undefined ? { label: delegation.label } : {}),
    })
  }

  private teamMemberOf(data: Record<string, unknown>, time: number): void {
    const member = asRecord(data.member)
    if (member === null || typeof member.id !== 'string' || member.id === '' || member.id === data.teamId) return
    const name = typeof member.name === 'string' && member.name !== '' ? member.name : undefined
    const fact = this.memberFactOf(member.id, name, time)
    const description = typeof member.description === 'string' && member.description !== '' ? member.description : undefined
    const phase = typeof member.phase === 'string' && member.phase !== '' ? member.phase : undefined
    this.teamFacts.set(fact.id, {
      ...fact,
      mode: 'continuable',
      ...(description === undefined ? {} : { description }),
      ...(phase === undefined ? {} : { phase }),
    })
  }

  members(): FleetSummaryMember[] {
    const ids = new Set([...this.catalogFacts.keys(), ...this.teamFacts.keys()])
    const out: MemberFact[] = []
    for (const id of ids) {
      const catalog = this.catalogFacts.get(id)
      const team = this.teamFacts.get(id)
      out.push({ ...team, ...catalog } as MemberFact)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  bytes(): number {
    let total = 0
    for (const message of this.messages) {
      total += message.text.length + (message.report?.length ?? 0) + (message.summary?.length ?? 0)
        + (message.structured?.length ?? 0) + (message.diagnostic?.length ?? 0) + (message.fromName?.length ?? 0)
    }
    total += this.initialPrompt?.length ?? 0
    total += this.lastReply?.text.length ?? 0
    for (const delegation of this.delegationAt.values()) total += delegation.label?.length ?? 0
    for (const member of this.roster.values()) total += member.name.length + member.description.length
    for (const fact of this.catalogFacts.values()) total += (fact.label?.length ?? 0) + (fact.name?.length ?? 0)
    for (const fact of this.teamFacts.values()) total += (fact.description?.length ?? 0) + (fact.name?.length ?? 0)
    return total
  }

  apply(events: readonly unknown[], inheritedEventCount = 0, admits?: (entry: unknown) => boolean): void {
    for (const entry of events) {
      if (admits === undefined || admits(entry)) this.applyEvent(entry, inheritedEventCount)
    }
  }

  private applyEvent(entry: unknown, inheritedEventCount: number): void {
    const ev = asRecord(entry)
    if (ev === null) return
    const type = ev.type
    if (typeof type !== 'string') return
    const seq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    const data = asRecord(ev.data)
    if (data === null) return
    if ((type === 'subagent/catalog' || type === 'team/member') && seq < inheritedEventCount) return
    if (type === 'subagent/catalog') {
      const delegation = delegationOf(seq, data)
      if (delegation !== null) this.delegationAt.set(delegation.to, delegation)
      this.catalogMemberOf(seq, data)
      return
    }
    if (type === 'subagent/descriptor') {
      const next = descriptorOf(data)
      if (next !== null) this.descriptor = next
      return
    }
    if (type === 'team/member') {
      const delegation = teamDelegationOf(seq, time, data)
      if (delegation !== null && !this.delegationAt.has(delegation.to)) this.delegationAt.set(delegation.to, delegation)
      const member = rosterMemberOf(data)
      if (member !== null) this.roster.set(member.name, member)
      this.teamMemberOf(data, time)
      return
    }
    if (type === 'assistant/message') {
      this.replyOf(seq, time, data)
      return
    }
    if (type !== 'user/message') return
    const message = messageOf(seq, time, data, this.caps.messageMax)
    if (message !== null) {
      this.total += 1
      this.insert(message)
      return
    }
    if (this.initialPrompt !== undefined || !isPlainPrompt(asRecord(data.source))) return
    const text = textOfContent(data.content).replace(REMINDER_PREFIX, '')
    if (text.trim() === '') return
    const cut = clip(text, this.caps.promptMax)
    this.initialPrompt = cut.text
    if (cut.cut) this.truncated = true
  }

  private replyOf(seq: number, time: number, data: Record<string, unknown>): void {
    const message = asRecord(data.message)
    const content = message?.content
    if (!Array.isArray(content)) return
    let text = ''
    for (const block of content) {
      const b = asRecord(block)
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    }
    if (text.trim() === '') return
    const cut = clip(text, this.caps.replyMax)
    this.lastReply = { time, text: cut.text }
    if (cut.cut) this.truncated = true
  }

  private insert(message: FleetMessage): void {
    this.messages.push(message)
    if (this.messages.length > this.caps.listMax) {
      this.messages.shift()
      this.truncated = true
    }
    if (message.clipped === true) this.truncated = true
  }

  serve(): FleetDetail {
    const messages = this.messages.slice().sort((a, b) => b.seq - a.seq)
    return {
      ...(this.descriptor !== undefined ? { descriptor: this.descriptor } : {}),
      ...(this.initialPrompt !== undefined ? { initialPrompt: this.initialPrompt } : {}),
      ...(this.lastReply !== null ? { lastReply: this.lastReply } : {}),
      ...(this.roster.size > 0 ? { roster: [...this.roster.values()] } : {}),
      ...(this.delegationAt.size > 0 ? { delegations: [...this.delegationAt.values()].sort((a, b) => a.seq - b.seq) } : {}),
      messages,
      ...(this.total > messages.length ? { messagesTotal: this.total } : {}),
      truncated: this.truncated,
    }
  }
}

export function fleetDetailOfEvents(events: readonly unknown[], mode: FleetDetailMode = 'preview', inheritedEventCount = 0): FleetDetail {
  const fold = new FleetFold(capsOf(mode))
  fold.apply(events, inheritedEventCount)
  return fold.serve()
}

interface FoldEntry {
  live: boolean
  persistence?: unknown
  revision?: string
  cursor: number
  count: number
  inheritedEventCount: number
  fold: FleetFold
}

const FOLD_CACHE_MAX = 32
const FOLD_BYTES_MAX = 4 * 1024 * 1024

interface ObservationLike {
  source?: unknown
  revision?: unknown
  inheritedEventCount?: unknown
  events?: unknown
  header?: unknown
  [Symbol.dispose]?: unknown
}

function createdAtOf(observation: ObservationLike | null): number | undefined {
  const header = asRecord(observation?.header)
  return typeof header?.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : undefined
}

function inheritedOf(observation: ObservationLike | null): number {
  const count = observation?.inheritedEventCount
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, count) : 0
}

function reusable(
  entry: FoldEntry,
  live: boolean,
  revision: string | undefined,
  persistence: unknown,
  events: readonly unknown[],
  cursor: number,
): boolean {
  if (live) {
    if (!entry.live || events.length < entry.count) return false
    return entry.count === 0 || ((events[entry.count - 1] as { seq?: unknown } | null)?.seq === entry.cursor)
  }
  return !entry.live && entry.revision === revision && entry.persistence === persistence && entry.cursor <= cursor
}

function foldOf(
  cache: FoldCache<FoldEntry>,
  sessionId: string,
  events: readonly unknown[],
  live: boolean,
  revision: string | undefined,
  persistence: unknown,
  cursor: number,
  inheritedEventCount: number,
): FleetFold {
  const entry = cache.get(sessionId, cached => reusable(cached, live, revision, persistence, events, cursor))
  if (entry !== undefined) {
    const from = live ? entry.count : events.length
    if (from < events.length) entry.fold.apply(events.slice(from), entry.inheritedEventCount)
    entry.count = events.length
    entry.cursor = cursor
    return entry.fold
  }
  const fold = new FleetFold(capsOf('preview'))
  fold.apply(events, inheritedEventCount)
  if (!live && revision === undefined) return fold
  cache.set(sessionId, {
    live,
    ...(revision !== undefined ? { revision } : {}),
    ...(persistence === undefined ? {} : { persistence }),
    cursor,
    count: events.length,
    inheritedEventCount,
    fold,
  })
  return fold
}

function countsOf(detail: FleetDetail, readAt: number): FleetDetailCounts {
  return {
    readAt,
    messagesTotal: detail.messagesTotal ?? detail.messages.length,
    delegationsCount: detail.delegations?.length ?? 0,
  }
}

function batchOf(body: unknown): FleetBatchRequest | null {
  const batch = asRecord(asRecord(body)?.batch)
  if (batch === null || !Array.isArray(batch.ids)) return null
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of batch.ids) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
    seen.add(entry)
    ids.push(entry)
    if (ids.length >= BATCH_MAX) break
  }
  if (ids.length === 0) return null
  const rootId = typeof batch.rootId === 'string' && batch.rootId !== '' ? batch.rootId : undefined
  return { ids, mode: batch.mode === 'history' ? 'history' : 'preview', ...(rootId === undefined ? {} : { rootId }) }
}

type ReadPeers = (ids: readonly string[]) => Promise<string[]>

interface CountScope {
  peers: ReadonlyMap<string, boolean>
}

interface CountEntry {
  counts: FleetDetailCounts
  scope?: CountScope
}

interface CountBucket {
  rootCreatedAt?: number
  children: Map<string, CountEntry>
}

const COUNTS_ROOTS_MAX = 8
const COUNTS_CHILDREN_MAX = 1023
const COUNTS_SCOPE_PEERS_MAX = 64

function bucketOf(counts: Map<string, CountBucket>, key: string, rootCreatedAt: number | undefined): CountBucket {
  const existing = counts.get(key)
  if (existing !== undefined) {
    counts.delete(key)
    if (existing.rootCreatedAt === rootCreatedAt) {
      counts.set(key, existing)
      return existing
    }
  }
  const bucket: CountBucket = { ...(rootCreatedAt === undefined ? {} : { rootCreatedAt }), children: new Map() }
  counts.set(key, bucket)
  while (counts.size > COUNTS_ROOTS_MAX) counts.delete(counts.keys().next().value as string)
  return bucket
}

function recordCount(bucket: CountBucket, id: string, counts: FleetDetailCounts, scope?: CountScope): void {
  bucket.children.delete(id)
  if (scope !== undefined && scope.peers.size > COUNTS_SCOPE_PEERS_MAX) return
  bucket.children.set(id, { counts, ...(scope === undefined ? {} : { scope }) })
  while (bucket.children.size > COUNTS_CHILDREN_MAX) bucket.children.delete(bucket.children.keys().next().value as string)
}

function matchesScope(scope: CountScope | undefined, readable: ReadonlySet<string>): boolean {
  for (const [peer, allowed] of scope?.peers ?? []) {
    if (readable.has(peer) !== allowed) return false
  }
  return true
}

async function knownCountsOf(
  bucket: CountBucket, ids: readonly string[], readPeers: ReadPeers | undefined,
): Promise<Record<string, FleetDetailCounts>> {
  const found: [string, CountEntry][] = []
  const peers = new Set<string>()
  for (const id of ids) {
    const entry = bucket.children.get(id)
    if (entry === undefined) continue
    for (const peer of entry.scope?.peers.keys() ?? []) peers.add(peer)
    found.push([id, entry])
  }
  const readable = readPeers === undefined || peers.size === 0 ? new Set<string>() : new Set(await readPeers([...peers]))
  return Object.fromEntries(found.flatMap(([id, entry]) => matchesScope(entry.scope, readable) ? [[id, entry.counts]] : []))
}

async function scopeOf(events: readonly unknown[], sessionId: string, readPeers: ReadPeers): Promise<CountScope> {
  const peers = new Map<string, boolean>()
  for (const entry of events) {
    const id = linkedSessionOf(entry)
    if (typeof id === 'string' && id !== sessionId) peers.set(id, false)
  }
  if (peers.size > 0) {
    for (const id of await readPeers([...peers.keys()])) peers.set(id, true)
  }
  return { peers }
}

export interface FleetRouteOptions {
  idleSweepMs?: number
}

export function watchFleetChannel(
  ctx: Context,
  coldReads: ColdReadGate = makeColdReadGate(),
  options: FleetRouteOptions = {},
): void {
  const counts = new Map<string, CountBucket>()
  const cache = makeFoldCache<FoldEntry>(ctx, {
    maxEntries: FOLD_CACHE_MAX,
    maxBytes: FOLD_BYTES_MAX,
    bytesOf: entry => entry.fold.bytes(),
    idleMs: options.idleSweepMs,
    onSweep: () => { counts.clear() },
  })
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: FLEET_ROUTE,
    label: 'dsh-context: fleet route',
    handler: (c) => {
      const persistence = serviceIdentityOf(c.get('sessionPersistence'))
      const sessions = c.get('sessions') as { get(id: string): unknown } | undefined
      const liveCreatedAtOf = (rootId: string): number | undefined => {
        try {
          const header = asRecord(asRecord(sessions?.get(rootId))?.header)
          return typeof header?.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : undefined
        } catch {
          return undefined
        }
      }
      const bucketKey = (id: string, scoped: boolean): string => `${scoped ? 'account' : 'local'}:${id}`
      const readFleet = async (
        sessionId: string, observation: ObservationLike | null, events: readonly unknown[],
        mode: FleetDetailMode, readPeers: ReadPeers | undefined,
      ): Promise<{ fold: FleetFold; scope?: CountScope }> => {
        const inherited = inheritedOf(observation)
        if (readPeers !== undefined) {
          const scope = await scopeOf(events, sessionId, readPeers)
          const fold = new FleetFold(capsOf(mode))
          fold.apply(events, inherited, (entry) => {
            const peer = linkedSessionOf(entry)
            return peer === undefined || peer === sessionId || (peer !== null && scope.peers.get(peer) === true)
          })
          return { fold, scope }
        }
        if (mode !== 'preview') {
          const fold = new FleetFold(capsOf(mode))
          fold.apply(events, inherited)
          return { fold }
        }
        const live = observation?.source === 'live'
        const revision = live ? undefined : revisionOf(observation)
        const fold = foldOf(cache, sessionId, events, live, revision, persistence, cursorOfEvents(events), inherited)
        return { fold }
      }
      const serveSummary = async (sessionId: string, readPeers: ReadPeers | undefined, signal: AbortSignal): Promise<Response> => {
        const observe = observeOf(ctx)
        if (observe === undefined) return reply({ ok: true, value: null })
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none', signal }) as ObservationLike | null
          const release = leaseOf(observation)
          try {
            const events = observation?.events
            if (!Array.isArray(events)) return null
            const { fold } = await readFleet(sessionId, observation, events, 'preview', readPeers)
            const detail = fold.serve()
            const members = fold.members()
            const rootCreatedAt = createdAtOf(observation)
            const bucket = bucketOf(counts, bucketKey(sessionId, readPeers !== undefined), rootCreatedAt)
            const known = await knownCountsOf(bucket, members.map(member => member.id), readPeers)
            const summaryCounts = Object.fromEntries([...Object.entries(known), [sessionId, countsOf(detail, Date.now())]])
            const summary: FleetSummary = {
              rootId: sessionId,
              ...(rootCreatedAt === undefined ? {} : { rootCreatedAt }),
              detail,
              members,
              familySize: members.length + 1,
              counts: summaryCounts,
            }
            return summary
          } finally {
            release()
          }
        })
        return reply({ ok: true, value: value ?? null })
      }
      const serveBatch = async (
        request: FleetBatchRequest, allowed: ReadonlySet<string>, readPeers: ReadPeers | undefined, signal: AbortSignal,
      ): Promise<Response> => {
        const observe = observeOf(ctx)
        if (observe === undefined) {
          return reply({ ok: true, value: { rows: {}, missing: request.ids, total: request.ids.length } })
        }
        const rows = new Map<string, { detail: FleetDetail; scope: CountScope | undefined }>()
        const subjects = new Set<string>()
        const rootId = request.rootId
        if (rootId !== undefined) subjects.add(rootId)
        await coldReads.admit(async () => {
          for (const id of request.ids) {
            signal.throwIfAborted()
            if (!allowed.has(id)) continue
            try {
              const observation = await observe(id, { projectionMode: 'none', signal }) as ObservationLike | null
              const release = leaseOf(observation)
              try {
                const events = observation?.events
                if (!Array.isArray(events)) continue
                const { fold, scope } = await readFleet(id, observation, events, request.mode, readPeers)
                rows.set(id, { detail: fold.serve(), scope })
                if (scope !== undefined) {
                  subjects.add(id)
                  for (const peer of scope.peers.keys()) subjects.add(peer)
                }
              } finally {
                release()
              }
            } catch (error) {
              if (error instanceof AccountAccessUnavailableError) throw error
              rows.delete(id)
            }
          }
        })
        if (readPeers !== undefined) {
          const readable = new Set(await readPeers([...subjects]))
          if (rootId !== undefined && !readable.has(rootId)) return failure('gateway/forbidden', 'session access denied')
          for (const [id, row] of rows) {
            if (!readable.has(id) || !matchesScope(row.scope, readable)) rows.delete(id)
          }
        }
        signal.throwIfAborted()
        const value: FleetBatchValue = {
          rows: Object.fromEntries([...rows].map(([id, row]) => [id, row.detail])),
          missing: request.ids.filter(id => !rows.has(id)),
          total: request.ids.length,
        }
        const bucket = rootId === undefined ? undefined : counts.get(bucketKey(rootId, readPeers !== undefined))
        if (rootId !== undefined && bucket !== undefined) {
          const liveCreatedAt = liveCreatedAtOf(rootId)
          if (bucket.rootCreatedAt === undefined || liveCreatedAt === undefined || liveCreatedAt === bucket.rootCreatedAt) {
            const readAt = Date.now()
            for (const [id, row] of rows) {
              if (id !== rootId) recordCount(bucket, id, countsOf(row.detail, readAt), row.scope)
            }
          }
        }
        return reply({ ok: true, value })
      }
      return async (request: Request, principal): Promise<Response> => {
        cache.touch()
        const read = await readBody(request)
        if (!read.ok) return read.response
        const body = read.body
        const record = asRecord(body)
        const readPeers: ReadPeers | undefined = isAccountRequest(c, principal)
          ? ids => readableAccountSessions(c, principal, ids, request.signal)
          : undefined
        const batch = batchOf(body)
        if (batch !== null) {
          try {
            const ids = batch.rootId === undefined ? batch.ids : [...new Set([batch.rootId, ...batch.ids])]
            const allowed = new Set(readPeers === undefined ? ids : await readPeers(ids))
            if (batch.rootId !== undefined && !allowed.has(batch.rootId)) return failure('gateway/forbidden', 'session access denied')
            return await serveBatch(batch, allowed, readPeers, request.signal)
          } catch (err) {
            return routeFailure(err)
          }
        }
        const sessionId = record?.sessionId
        const mode = detailModeOf(body)
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('dsh-context/bad-request', 'missing sessionId')
        }
        try {
          if (!await canReadAccountSession(c, principal, sessionId, request.signal)) return failure('gateway/forbidden', 'session access denied')
          if (record?.summary === true) return await serveSummary(sessionId, readPeers, request.signal)
          const observe = observeOf(ctx)
          if (observe === undefined) return reply({ ok: true, value: null })
          const value = await coldReads.admit(async () => {
            const observation = await observe(sessionId, { projectionMode: 'none', signal: request.signal }) as ObservationLike | null
            const release = leaseOf(observation)
            try {
              const events = observation?.events
              if (!Array.isArray(events)) return null
              return (await readFleet(sessionId, observation, events, mode, readPeers)).fold.serve()
            } finally {
              release()
            }
          })
          request.signal.throwIfAborted()
          return reply({ ok: true, value: value ?? null })
        } catch (err) {
          return routeFailure(err)
        }
      }
    },
  })
}

function cursorOfEvents(events: readonly unknown[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const seq = (events[i] as { seq?: unknown } | null)?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) return seq
  }
  return -1
}
