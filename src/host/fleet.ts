/** The Fleet detail route (`/api/dsh-context/fleet`): per-session agent color no projection carries — the delegation prompt, the
 * `subagent/descriptor` composition, and attested inter-agent traffic. Display-only and total; a `full: true` body lifts the excerpt
 * caps for the task card's opened sections. */

import type { Context } from '@deepseek-ai/cordis'
import type { FleetDescriptor, FleetDetail, FleetMemberInfo, FleetMessage } from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { canReadAccountSession, type ConnectionHostFace, registerPostRoute } from './connection'

export const FLEET_ROUTE = '/api/dsh-context/fleet'

/** The fold's default read serves inspector excerpts, not transcripts. */
const MESSAGES_MAX = 80
const MESSAGE_TEXT_MAX = 400
const PROMPT_TEXT_MAX = 1600
const REPLY_TEXT_MAX = 300
/** A full read lifts the excerpt caps for one opened message; the hostile-payload bounds stay. 120 messages cover every
 * excerpt row (80), so an opened message is always present while older history stays bounded. */
const FULL_MESSAGES_MAX = 120
const FULL_MESSAGE_TEXT_MAX = 24_000
/** The full read's only bound: DSH never truncates these, but a corrupted log must not flood the client. */
const FULL_TEXT_MAX = 100_000

function fullOf(body: unknown): boolean {
  return asRecord(body)?.full === true
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

/** The mailbox generation stamps each delivery with a transport preamble; the excerpt drops it. */
const MAILBOX_PREFIX = /^Team message \S+ from ([^:]{1,64}):\s*/
/** Relay deliveries open with a sender-framing block; the excerpt drops it — the UI labels the parties itself. */
const RELAY_PREFIX = /^(?:Agent \S+ sent a message: |Team message from ([^:\n]{1,64}):\s*)/

/** The runtime's settlement notice vocabulary (`createSettlementMessage` in dsh's subagent package). */
const CLOSING_HEAD = 'Its closing message:'
const NO_CLOSING = 'It left no closing message.'
const CLOSING_OMITTED = 'It sent you a message just before finishing, so its closing message is omitted.'
const STRUCTURED_HEAD = 'Structured result: '

/** End index of the leading JSON value, or 0 when the text starts with something else. String-aware, so a brace inside
 * a quoted value cannot close the scan; an unterminated value spans the whole remainder. */
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
  // A diagnostic with no structured payload arrives as a bare block after the closing text; with no marker it cannot be
  // told apart from the report, so it stays there.
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
    // The notice's content starts with its summary and carries the closing report behind it. A hostile content that
    // does not open with the attested summary contributes nothing but the summary itself.
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

/** A human-typed prompt or a delegation's initial delivery (kind `'user'` or unattributed), not injected context. */
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

function lastReplyOf(events: readonly unknown[], max: number): { time: number; text: string; cut: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = asRecord(events[i])
    if (ev === null || ev.type !== 'assistant/message') continue
    const message = asRecord(asRecord(ev.data)?.message)
    const content = message?.content
    if (!Array.isArray(content)) continue
    let text = ''
    for (const block of content) {
      const b = asRecord(block)
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    }
    if (text.trim() === '') continue
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    const cut = clip(text, max)
    return { time, text: cut.text, cut: cut.cut }
  }
  return null
}

/** Total over hostile input: a malformed entry drops alone. `full` lifts the prompt/reply/message excerpt caps for one
 * opened card, keeping the hostile-payload bounds. */
export function fleetDetailOfEvents(events: readonly unknown[], full = false): FleetDetail {
  const promptMax = full ? FULL_TEXT_MAX : PROMPT_TEXT_MAX
  const replyMax = full ? FULL_TEXT_MAX : REPLY_TEXT_MAX
  const messageMax = full ? FULL_MESSAGE_TEXT_MAX : MESSAGE_TEXT_MAX
  const listMax = full ? FULL_MESSAGES_MAX : MESSAGES_MAX
  let descriptor: FleetDescriptor | undefined
  let initialPrompt: string | undefined
  let truncated = false
  let total = 0
  const messages: FleetMessage[] = []
  const roster = new Map<string, FleetMemberInfo>()
  for (const entry of events) {
    const ev = asRecord(entry)
    if (ev === null) continue
    const type = ev.type
    if (typeof type !== 'string') continue
    const seq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    const data = asRecord(ev.data)
    if (data === null) continue
    if (type === 'subagent/descriptor') {
      // Last wins: a fork seed replays the ancestor's descriptor before the child's own.
      const next = descriptorOf(data)
      if (next !== null) descriptor = next
      continue
    }
    if (type === 'team/member') {
      // The whole roster row rewrites per lifecycle step; the latest record's facts stand.
      const member = rosterMemberOf(data)
      if (member !== null) roster.set(member.name, member)
      continue
    }
    if (type !== 'user/message') continue
    const message = messageOf(seq, time, data, messageMax)
    if (message !== null) {
      total += 1
      if (message.clipped === true) truncated = true
      messages.push(message)
      continue
    }
    if (initialPrompt === undefined && isPlainPrompt(asRecord(data.source))) {
      const text = textOfContent(data.content).replace(REMINDER_PREFIX, '')
      if (text.trim() !== '') {
        const cut = clip(text, promptMax)
        initialPrompt = cut.text
        if (cut.cut) truncated = true
      }
    }
  }
  messages.sort((a, b) => b.seq - a.seq)
  if (messages.length > listMax) {
    messages.length = listMax
    truncated = true
  }
  const reply = lastReplyOf(events, replyMax)
  if (reply !== null && reply.cut) truncated = true
  return {
    ...(descriptor !== undefined ? { descriptor } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(reply !== null ? { lastReply: { time: reply.time, text: reply.text } } : {}),
    ...(roster.size > 0 ? { roster: [...roster.values()] } : {}),
    messages,
    ...(total > messages.length ? { messagesTotal: total } : {}),
    truncated,
  }
}

/** Serve whenever `connection` is composed; `sessionQuery` is re-read per request so a late-arriving service arms. */
export function watchFleetChannel(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (request: Request, principal?: unknown): Promise<Response> => {
      let sessionId: unknown
      let full = false
      try {
        const body: unknown = await request.json()
        sessionId = asRecord(body)?.sessionId
        full = fullOf(body)
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      try {
        if (!await canReadAccountSession(c, principal, sessionId, request.signal)) return failure('gateway/forbidden', 'session access denied')
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return reply({ ok: true, value: null })
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          const events = (observation as { events?: unknown } | null)?.events
          if (!Array.isArray(events)) return null
          try {
            return fleetDetailOfEvents(events, full)
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, FLEET_ROUTE, handler, 'dsh-context: fleet route')
  })
}
