/** The `contextActivity` unit: a per-day ledger keyed by local calendar day; billed buckets and tool time attribute to the day the open
 * step STARTED. Bounded by {@link MAX_KEPT_DAYS}, never materializing `undefined`-valued properties. */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WiredProjection } from './projection'
import { skillNameOf } from './fold'
import { addBilledUsage, copyCostUsage, durOf, tokenCountOf } from './foldMetering'
import type { BilledUsage, UsageLike } from './foldMetering'
import { costUsageSchema } from './timeline'
import { dayKeyOf } from '../shared/days'
import type { ActivityDay, ContextActivity } from '../shared/types'

const MAX_KEPT_DAYS = 400

/** Cap on one day's skill-name table; a hostile replay could stuff a name into every injection. */
const MAX_SKILLS_PER_DAY = 100

/** Bound on the pending `skill`-call id list. */
const MAX_PENDING_SKILL_CALLS = 100

/** Bound on the pending tool-call start table, which a hostile unsettled stream could otherwise grow. */
const MAX_PENDING_TOOL_CALLS = 100

interface ToolStart {
  start: number
  day: string
}

export interface ActivityState {
  days: Record<string, ActivityDay>
  /** The route in force (the last `request/header`'s config wins) — prices each settlement. */
  model?: string
  provider?: string
  stepStart?: number
  /** The last turn whose first settlement was booked, so a multi-step turn counts once. */
  lastTurn?: number
  toolStarts?: Record<string, ToolStart | undefined>
  /** Pending `skill`-tool call ids: the wrapper match alone is not trusted, or a `read` quoting it would book a load. */
  skillCalls?: string[]
}

const activitySkillSchema = z.object({
  n: z.number().int().nonnegative(),
  last: z.number(),
}).strict()

const toolStartSchema = z.object({
  start: z.number().nonnegative(),
  day: z.string(),
}).strict()

const activityDaySchema = z.object({
  tokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  cost: costUsageSchema.optional(),
  turns: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  toolsMs: z.number().nonnegative().optional(),
  wallMs: z.number().nonnegative().optional(),
  skills: z.record(z.string(), activitySkillSchema).optional(),
}).strict()
export const contextActivitySchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}).strict() as unknown as z.ZodType<ContextActivity>

const activityStateSchema = z.object({
  days: z.record(z.string(), activityDaySchema),
  model: z.string().optional(),
  provider: z.string().optional(),
  stepStart: z.number().optional(),
  lastTurn: z.number().optional(),
  toolStarts: z.record(z.string(), toolStartSchema).optional(),
  skillCalls: z.array(z.string()).optional(),
}) as unknown as z.ZodType<ActivityState>

/** A settlement with no readable bucket still counts its request, without fabricating tokens. */
function billedBucketsOf(value: unknown): BilledUsage | null {
  if (value === null || typeof value !== 'object') return null
  const usage = value as UsageLike
  const input = tokenCountOf(usage.inputTokens)
  const cacheRead = tokenCountOf(usage.cacheReadTokens)
  const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
  const output = tokenCountOf(usage.outputTokens)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return { uncached: input ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, output: output ?? 0 }
}

/** A dynamic `delete` per evicted key deopts the record, so the kept suffix rebuilds. */
function withDayEntry(state: ActivityState, key: string, entry: ActivityDay): ActivityState {
  let days = { ...state.days, [key]: entry }
  const keys = Object.keys(days)
  if (keys.length > MAX_KEPT_DAYS) {
    keys.sort()
    const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)))
  }
  return { ...state, days }
}

/** Nested records ride by reference; the fold never mutates them in place. */
function copyDay(prev: ActivityDay | undefined): ActivityDay {
  return {
    tokens: prev?.tokens ?? 0,
    requests: prev?.requests ?? 0,
    ...(prev?.cost !== undefined ? { cost: prev.cost } : {}),
    ...(prev?.turns !== undefined ? { turns: prev.turns } : {}),
    ...(prev?.toolCalls !== undefined ? { toolCalls: prev.toolCalls } : {}),
    ...(prev?.toolsMs !== undefined ? { toolsMs: prev.toolsMs } : {}),
    ...(prev?.wallMs !== undefined ? { wallMs: prev.wallMs } : {}),
    ...(prev?.skills !== undefined ? { skills: prev.skills } : {}),
  }
}

function withDayPatch(state: ActivityState, key: string, patch: Partial<ActivityDay>): ActivityState {
  return withDayEntry(state, key, { ...copyDay(state.days[key]), ...patch })
}

function withToolStart(state: ActivityState, callId: string, start: number): ActivityState {
  if (!Number.isFinite(start) || start < 0) return state
  const day = dayKeyOf(state.stepStart ?? start)
  if (day === null) return state
  const prev = state.toolStarts?.[callId]
  if (prev !== undefined && prev.start === start && prev.day === day) return state
  const starts: Record<string, ToolStart | undefined> = { ...state.toolStarts, [callId]: { start, day } }
  const entries = Object.entries(starts)
  const toolStarts = entries.length > MAX_PENDING_TOOL_CALLS
    ? Object.fromEntries(entries.slice(entries.length - MAX_PENDING_TOOL_CALLS))
    : starts
  return { ...state, toolStarts }
}

function bookToolResult(state: ActivityState, callId: string, end: number): ActivityState {
  const starts = state.toolStarts
  const start = starts?.[callId]
  if (starts === undefined || start === undefined) return state
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const day = byKey[start.day]
  const timed = withDayPatch(state, start.day, {
    toolCalls: (day?.toolCalls ?? 0) + 1,
    toolsMs: (day?.toolsMs ?? 0) + durOf(start.start, end),
  })
  const kept = Object.fromEntries(Object.entries(starts).filter(([id]) => id !== callId))
  const next = { ...timed }
  if (Object.keys(kept).length > 0) next.toolStarts = kept
  else delete next.toolStarts
  return next
}

/** The tally never walks back on a disordered replay; a day at the name cap drops the newcomer. */
function bookSkillLoad(state: ActivityState, name: string, time: number): ActivityState {
  const key = dayKeyOf(time)
  if (key === null) return state
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  const existing = prev?.skills !== undefined && Object.hasOwn(prev.skills, name) ? prev.skills[name] : undefined
  if (existing === undefined && prev?.skills !== undefined && Object.keys(prev.skills).length >= MAX_SKILLS_PER_DAY) return state
  const skills = {
    ...prev?.skills,
    [name]: { n: (existing?.n ?? 0) + 1, last: existing === undefined ? time : Math.max(existing.last, time) },
  }
  return withDayEntry(state, key, { ...copyDay(prev), skills })
}

/** A user-explicit `/name` invocation's durable `skill-invocation` envelope; anything else is no load. */
function invokedSkillOf(event: SessionEvent): string {
  const data = event.data as { source?: unknown; message?: unknown } | null | undefined
  const carrier = event.type === 'developer/message' ? data?.message : data
  const source = carrier !== null && typeof carrier === 'object'
    ? (carrier as { source?: unknown }).source
    : undefined
  if (source === null || typeof source !== 'object') return ''
  const rec = source as { kind?: unknown; name?: unknown }
  return rec.kind === 'skill-invocation' && typeof rec.name === 'string' ? rec.name : ''
}

function toolResultCallIdOf(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const rec = message as { toolCallId?: unknown; source?: unknown }
  if (typeof rec.toolCallId === 'string' && rec.toolCallId !== '') return rec.toolCallId
  const source = rec.source
  if (source === null || typeof source !== 'object') return null
  const callId = (source as { callId?: unknown }).callId
  return typeof callId === 'string' && callId !== '' ? callId : null
}
/** Reference-equal on no change; every mutation copies along its path, never mutating the persisted previous state. */
export function applyActivity(state: ActivityState, event: SessionEvent): ActivityState {
  if (event.type === 'request/header') {
    const data = event.data as { header?: { config?: { model?: unknown; provider?: unknown } | null } | null } | undefined
    const config = data?.header?.config
    if (config === null || typeof config !== 'object') return state
    const model = typeof config.model === 'string' ? config.model : undefined
    const provider = typeof config.provider === 'string' ? config.provider : undefined
    const nextModel = model !== undefined ? model : state.model
    const nextProvider = provider !== undefined ? provider : state.provider
    if (nextModel === state.model && nextProvider === state.provider) return state
    return {
      ...state,
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    }
  }
  if (event.type === 'step/start') {
    if (!Number.isFinite(event.time)) return state
    return state.stepStart === event.time ? state : { ...state, stepStart: event.time }
  }
  if (event.type === 'step/end') {
    const start = state.stepStart
    if (start === undefined) return state
    // Wall time is charged to the START day, so a step crossing midnight stays on the day it began.
    const key = dayKeyOf(start)
    const dur = durOf(start, event.time)
    const timed = key === null || dur <= 0
      ? state
      : withDayPatch(state, key, { wallMs: (state.days[key]?.wallMs ?? 0) + dur })
    // DELETE the field — assigning `undefined` would break the plain-JSON precondition.
    const next = { ...timed }
    delete next.stepStart
    return next
  }
  if (event.type === 'session/end-seed') {
    // The tagged fork/seed boundary: inherited settlements were booked to the parent session, so the ledger resets;
    // `stepStart` dies with the cut, so an inherited armed slot cannot misattribute the child's first day.
    const data = event.data as { inherited?: unknown } | null | undefined
    if (data?.inherited !== true) return state
    return { days: {} }
  }
  if (event.type === 'user/message' || event.type === 'developer/message') {
    const name = invokedSkillOf(event)
    return name === '' ? state : bookSkillLoad(state, name, event.time)
  }
  if (event.type === 'tool/call') {
    const data = event.data as { callId?: unknown; name?: unknown } | null | undefined
    const callId = data?.callId
    if (typeof callId !== 'string' || callId === '') return state
    // Every tool run times against its step's initiation day; the skill tool additionally arms a pairing claim.
    const next = withToolStart(state, callId, event.time)
    if (data?.name !== 'skill') return next
    const pending = next.skillCalls ?? []
    if (pending.includes(callId)) return next
    return { ...next, skillCalls: [...pending, callId].slice(-MAX_PENDING_SKILL_CALLS) }
  }
  if (event.type === 'tool/result') {
    // Price the paired run first, then consume the `skill`-tool load claim: the wrapper is trusted only under the matching pending call.
    const message = (event.data as { message?: unknown } | null | undefined)?.message
    const callId = toolResultCallIdOf(message)
    const next = callId === null ? state : bookToolResult(state, callId, event.time)
    const pending = next.skillCalls
    if (callId === null || pending === undefined || !pending.includes(callId)) return next
    const skillCalls = pending.filter(id => id !== callId)
    const consumed: ActivityState = { ...next }
    if (skillCalls.length > 0) consumed.skillCalls = skillCalls
    else delete consumed.skillCalls
    const name = skillNameOf(message)
    return name === '' ? consumed : bookSkillLoad(consumed, name, event.time)
  }
  if (event.type !== 'assistant/message') return state
  // The open step's initiation instant, falling back to this settlement's own; the slot stays armed, so a second settlement of the same
  // step still reads it.
  const initiated = state.stepStart !== undefined ? state.stepStart : event.time
  const key = dayKeyOf(initiated)
  if (key === null) return state
  const data = event.data as { usage?: unknown; turn?: unknown } | undefined
  const buckets = billedBucketsOf(data?.usage)
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  // A settlement prices only with a model in force: a model-less one counts its tokens and request, never a fee.
  let cost = prev?.cost
  if (buckets !== null && state.model !== undefined) {
    cost = addBilledUsage(cost, state.provider ?? '', state.model, initiated, buckets)
  }
  // A turn books once, on the initiation day of its FIRST settlement; the cursor dies at a tagged seed cut.
  const turn = typeof data?.turn === 'number' && Number.isFinite(data.turn) ? data.turn : undefined
  const newTurn = turn !== undefined && turn !== state.lastTurn
  const turns = (prev?.turns ?? 0) + (newTurn ? 1 : 0)
  const entry: ActivityDay = {
    tokens: (prev === undefined ? 0 : prev.tokens)
      + (buckets === null ? 0 : buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output),
    requests: (prev === undefined ? 0 : prev.requests) + 1,
    ...(cost !== undefined ? { cost } : {}),
    ...(turns > 0 ? { turns } : {}),
    ...(prev?.toolCalls !== undefined ? { toolCalls: prev.toolCalls } : {}),
    ...(prev?.toolsMs !== undefined ? { toolsMs: prev.toolsMs } : {}),
    ...(prev?.wallMs !== undefined ? { wallMs: prev.wallMs } : {}),
    ...(prev?.skills !== undefined ? { skills: prev.skills } : {}),
  }
  const next = withDayEntry(state, key, entry)
  return newTurn ? { ...next, lastTurn: turn } : next
}

/** `stateVersion` 5: rows folded before the turn cursor, tool timings and step wall time read version-stale and cold-refold. */
export function createContextActivityDefinition(): WiredProjection<'contextActivity', ActivityState> {
  return {
    key: 'contextActivity',
    stateSchema: activityStateSchema,
    init: (): ActivityState => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => applyActivity(state, event),
    // The view copies the ledger AND each entry's nested records so the registry, the cache writer and the wire can never mutate the fold's
    // own record.
    wire: {
      viewSchema: contextActivitySchema,
      view: state => ({
        days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, {
          ...v,
          // Conditional spread: an `undefined`-valued property fails the whole lossless-JSON push.
          ...(v.cost !== undefined ? { cost: copyCostUsage(v.cost) } : {}),
          ...(v.skills !== undefined
            ? { skills: Object.fromEntries(Object.entries(v.skills).map(([n, t]) => [n, { ...t }])) }
            : {}),
        }])),
      }),
    },
    stateVersion: 5,
  }
}
