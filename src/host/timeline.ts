/** The `contextTimeline` session projection unit: pure `apply`/`view` math on the harness's projection registry — no subscriptions, no
 * client access; checkpoint persistence and push delivery are the framework's. */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config'
import { resolveBounds } from './config'
import type { WiredProjection } from './projection'
import type { ContextTimeline } from '../shared/types'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import type { TimelineState } from './foldState'
import { buildTimelineHead, buildTimelineView } from './foldWire'

const surfaceNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number().optional(),
  cat: z.enum(['user', 'inject', 'skill', 'assistant', 'tool']),
  tokens: z.number().int().nonnegative(),
  imgs: z.number().int().nonnegative().optional(),
  gone: z.number().int().nonnegative().optional(),
  form: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  err: z.boolean().optional(),
  skill: z.string().optional(),
  calls: z.array(z.string()).optional(),
}).strict()

const systemPromptNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number(),
  tokens: z.number().int().nonnegative(),
}).strict()

const requestRecordSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  time: z.number(),
  seq: z.number(),
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative().optional(),
  /** Additive-optional: rows folded before the category existed still parse. */
  skill: z.number().int().nonnegative().optional(),
  cacheRead: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  /** The request's step active ms; optional so a record whose step never closed (the live tail) still parses. */
  activeMs: z.number().nonnegative().optional(),
  stepCount: z.number().int().positive().optional(),
}).strict()

const contextEventSchema = z.object({
  seq: z.number(),
  time: z.number(),
  kind: z.enum(['compaction', 'prune', 'inject', 'model', 'mode']),
  form: z.string().optional(),
  tokens: z.number().optional(),
  count: z.number().optional(),
  sub: z.string().optional(),
  name: z.string().optional(),
  detail: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fromTurn: z.number().optional(),
  fromStep: z.number().optional(),
  turn: z.number().optional(),
  step: z.number().optional(),
}).strict()

const fileOpSchema = z.object({
  seq: z.number().int().nonnegative(),
  path: z.string(),
  kind: z.enum(['read', 'write', 'search']),
  tool: z.string(),
  time: z.number().optional(),
  err: z.boolean(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  detail: z.string().optional(),
  hits: z.number().int().positive().optional(),
  read: z.union([
    z.object({ start: z.number().int().positive(), count: z.number().int().nonnegative() }).strict(),
    z.object({ count: z.number().int().positive(), est: z.literal(true) }).strict(),
  ]).optional(),
  parent: z.number().int().nonnegative().optional(),
  program: z.string().optional(),
  pattern: z.literal(true).optional(),
  gone: z.number().int().nonnegative().optional(),
}).strict()

const commandSchema = z.object({
  seq: z.number().int().nonnegative(),
  resultSeq: z.number().int().nonnegative().optional(),
  time: z.number(),
  tool: z.string(),
  cmd: z.string(),
  cmdTruncated: z.literal(true).optional(),
  description: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
  background: z.literal(true).optional(),
  sandbox: z.string().optional(),
  codeMode: z.literal(true).optional(),
  parent: z.number().int().nonnegative().optional(),
  turn: z.number().optional(),
  step: z.number().optional(),
  start: z.number(),
  end: z.number().optional(),
  status: z.enum(['running', 'completed', 'failed', 'killed']),
  exit: z.number().int().optional(),
  exitInferred: z.literal(true).optional(),
  signal: z.string().optional(),
  timedOut: z.literal(true).optional(),
  stopped: z.literal(true).optional(),
  denied: z.literal(true).optional(),
  err: z.boolean(),
  outChars: z.number().int().nonnegative().optional(),
  outTruncated: z.literal(true).optional(),
  stderr: z.literal(true).optional(),
  derived: z.literal(true).optional(),
  gone: z.number().int().nonnegative().optional(),
}).strict()

/** The persisted record adds the fold's pairing key, stripped by the wire builders. */
const commandStateSchema = commandSchema.extend({
  call: z.string().optional(),
}).strict()

const commandStatsSchema = z.object({
  runs: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
  bg: z.number().int().nonnegative(),
}).strict()

const timingSpanSchema = z.object({
  kind: z.enum(['ttft', 'reasoning', 'text', 'toolarg', 'tools', 'other']),
  start: z.number(),
  end: z.number(),
}).strict()

const currentSchema = z.object({
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
  skill: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

const costBucketsSchema = z.object({
  uncached: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
}).strict()

const costModelSchema = z.object({
  peak: costBucketsSchema.optional(),
  off: costBucketsSchema.optional(),
}).strict()

const costModelsSchema = z.record(z.string(), costModelSchema)

export const costUsageSchema = z.record(z.string(), costModelsSchema)

const toolTimingSchema = z.object({
  calls: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
}).strict()

const timingTotalsSchema = z.object({
  wallMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  genMs: z.number().nonnegative(),
  // Additive-optional: rows cached before the generation split, the block counts or the throughput seat existed parse.
  reasoningMs: z.number().nonnegative().optional(),
  reasoningBlocks: z.number().int().nonnegative().optional(),
  textMs: z.number().nonnegative().optional(),
  textBlocks: z.number().int().nonnegative().optional(),
  toolArgMs: z.number().nonnegative().optional(),
  toolArgBlocks: z.number().int().nonnegative().optional(),
  speedTokens: z.number().nonnegative().optional(),
  speedMs: z.number().nonnegative().optional(),
  calls: z.number().int().nonnegative(),
  toolsMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tools: z.record(z.string(), toolTimingSchema),
}).strict()

const unsupportedSchema = z.object({
  current: z.string(),
  minimum: z.string(),
}).strict()

const countsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  injects: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
  prunes: z.number().int().nonnegative(),
  // Additive-optional like every head field derived at view time: a cached row restores with its full event set.
  skills: z.number().int().nonnegative().optional(),
}).strict()

const lastSchema = z.object({
  seq: z.number(),
  total: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative().optional(),
}).strict()

/** One wire contract for both generations: the SPLIT head (envelope scalars + counts/last/detailRev, heavy collections
 * on the detail channel) and the INLINE value (collections in place); `detailRev` present ⟺ split. */
export const contextTimelineSchema = z.object({
  ok: z.literal(true),
  unsupported: unsupportedSchema.optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  reasoningEffort: z.string().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().positive().optional(),
  current: currentSchema,
  images: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  humanInputs: z.number().int().nonnegative().optional(),
  // Additive-optional like `humanInputs`: a pre-field row reads without it and clients degrade to zero.
  answers: z.number().int().nonnegative().optional(),
  lastUser: z.string().optional(),
  counts: countsSchema.optional(),
  last: lastSchema.optional(),
  detailRev: z.number().int().nonnegative().optional(),
  requests: z.array(requestRecordSchema).optional(),
  events: z.array(contextEventSchema).optional(),
  cost: costUsageSchema.optional(),
  timing: timingTotalsSchema.optional(),
  systems: z.array(systemPromptNodeSchema).optional(),
  nodes: z.array(surfaceNodeSchema).optional(),
  droppedNodes: z.number().int().nonnegative().optional(),
  archive: z.array(surfaceNodeSchema).optional(),
  surfaceFloor: z.number().int().nonnegative().optional(),
  archiveFloor: z.number().int().nonnegative().optional(),
  fileOps: z.array(fileOpSchema).optional(),
  fileOpsFloor: z.number().int().nonnegative().optional(),
  commands: z.array(commandSchema).optional(),
  commandsFloor: z.number().int().nonnegative().optional(),
  commandStats: commandStatsSchema.optional(),
  spans: z.array(timingSpanSchema).optional(),
}).strict() as unknown as z.ZodType<ContextTimeline>

/** The registry's `stateSchema` contract: validates plain-JSON `TimelineState` before a checkpoint row seeds a fold. */
const timelineStateSchema = z.object({
  surface: z.array(surfaceNodeSchema),
  sums: z.object({
    user: z.number().int().nonnegative(),
    inject: z.number().int().nonnegative(),
    skill: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    tool: z.number().int().nonnegative(),
  }).strict(),
  systemTokens: z.number().int().nonnegative(),
  systems: z.array(systemPromptNodeSchema).optional(),
  toolsTokens: z.number().int().nonnegative(),
  model: z.string().optional(),
  provider: z.string().optional(),
  reasoningEffort: z.string().optional(),
  lastModel: z.string().optional(),
  contextWindow: z.number().optional(),
  maxOutputTokens: z.number().positive().optional(),
  requests: z.array(requestRecordSchema),
  turnRuns: z.number().int().nonnegative().optional(),
  events: z.array(contextEventSchema),
  archived: z.array(surfaceNodeSchema),
  cost: costUsageSchema.optional(),
  archiveFloor: z.number().optional(),
  timing: timingTotalsSchema.optional(),
  humanInputs: z.number().int().nonnegative().optional(),
  answers: z.number().int().nonnegative().optional(),
  lastUser: z.string().optional(),
  stepStart: z.object({
    time: z.number(),
    firstToken: z.number().optional(),
  }).strict().optional(),
  stepWaits: z.array(z.object({ start: z.number(), end: z.number() }).strict()).optional(),
  stepApprovals: z.record(z.string(), z.number()).optional(),
  stepRequestSeq: z.number().optional(),
  callNames: z.record(z.string(), z.object({ name: z.string(), start: z.number(), argsRaw: z.string().optional() }).strict()),
  pendingShadowedSeqs: z.array(z.number()).optional(),
  pendingShadowEventSeq: z.number().optional(),
  detailRev: z.number().int().nonnegative().optional(),
  fileOps: z.array(fileOpSchema),
  fileOpsFloor: z.number().int().nonnegative().optional(),
  commands: z.array(commandStateSchema),
  commandsFloor: z.number().int().nonnegative().optional(),
  commandStats: commandStatsSchema.optional(),
  pendingCodeCmds: z.record(z.string(), z.array(commandStateSchema)).optional(),
  spans: z.array(timingSpanSchema),
  stepSpans: z.array(timingSpanSchema).optional(),
  pendingCodeOps: z.record(z.string(), z.array(fileOpSchema)).optional(),
}) as unknown as z.ZodType<TimelineState>

/**
 * Created per plugin instance with its config-resolved retention bounds. Without a `wire` block the registry serves
 * nothing and the Context tab waits on its loading screen forever; `slim` picks the wire generation PER SERVE as a
 * liveness probe — the split is view-only, both generations validate against one schema over the same state.
 */
export function createContextTimelineDefinition(config: Config, slim: () => boolean): WiredProjection<'contextTimeline', TimelineState> {
  const bounds = resolveBounds(config)
  const view = (state: TimelineState): ContextTimeline =>
    slim() ? buildTimelineHead(state) : buildTimelineView(state, bounds)
  const definition: WiredProjection<'contextTimeline', TimelineState> = {
    key: 'contextTimeline',
    stateSchema: timelineStateSchema,
    wire: { viewSchema: contextTimelineSchema, view },
    init: () => createTimelineState(),
    apply: (state: TimelineState, event: SessionEvent) => applyTimeline(state, event as Parameters<typeof applyTimeline>[1], bounds),
    // Bump on any persisted-shape or fold-semantics change, which refolds cached rows; never for a backfillable or serve-time-derived
    // field, since invalidating in-generation rows orphans idle sessions with no refresh channel.
    stateVersion: 31,
  }
  return definition
}
