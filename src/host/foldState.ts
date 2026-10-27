/** The timeline fold's persisted state shape, event envelope, construction and retention bounds — the plain JSON the projection cache
 * checkpoints. `fold.ts` owns the reducer that writes it. */

import type { OutputTokenParts, Category, CommandRecord, CommandStats, ContextEventRecord, FileOpRecord, RequestRecord, SessionCostUsage, SurfaceNode, SystemPromptNode, TimingSpan, TimingTotals } from '../shared/types'
import type { FoldBounds } from './config'

/** The state's command record: the wire record plus the callId the fold pairs result/job events on. Never served —
 * `foldWire` strips it (optional precisely so the strip is a plain `delete`). */
export interface CommandStateRecord extends CommandRecord {
  call?: string
}

/** The core `SessionEvent` union carries only core types; plugin-merged vocabulary (the `compaction/*` family, declared by
 * `dsh-compaction`) is absent, and the fold must not depend on those packages — so it widens here. */
export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

export interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[]
  sums: Record<Category, number>
  /** Live assistant-node reasoning price — a running subset of `sums.assistant` (the thinking split's prompt-side share). */
  assistantReasoning: number
  /** Live assistant-node text price — a running subset of `sums.assistant` (the answers split's prompt-side share). */
  assistantAnswerTokens: number
  /** Live assistant-node tool-call price — a running subset of `sums.assistant` (the tool-call split's prompt-side share). */
  assistantCallTokens: number
  systemTokens: number
  /** The live system-prompt nodes, oldest first; `systemTokens` is the LAST nonempty one (the harness rule), so an empty dormant node
   * keeps its position. Absent rows fall back to the header epoch's envelope figure. */
  systems?: SystemPromptNode[]
  toolsTokens: number
  /** The projection cache requires plain JSON: an `undefined`-valued property fails EVERY cache write for the session, so optional fields
   * stay absent until a value is known. */
  model?: string
  provider?: string
  /** Last-wins: a header without an effort clears it. */
  reasoningEffort?: string
  lastModel?: string
  contextWindow?: number
  /** The newest `request/header` envelope's routed output cap (dsh materializes the adapter default into it). Last-wins: a header
   * omitting the cap clears it. */
  maxOutputTokens?: number
  requests: RequestRecord[]
  /** Turn runs in `requests` (consecutive records sharing one `turn`), maintained at the single append site and recomputed on trim, so
   * the cap check stays O(1); absent on older rows. */
  turnRuns?: number
  events: ContextEventRecord[]
  /** Removed surface nodes as stamped COPIES carrying `gone`, in removal order; bounded to `maxArchiveNodes` and pruned to removals after
   * the oldest retained request. */
  archived: SurfaceNode[]
  /** Cumulative billed-token totals per (provider, model, period); never trimmed, so the estimate covers the COMPLETE log. */
  cost?: SessionCostUsage
  /** Cumulative generated reasoning price over the COMPLETE log (the thinking split's output side); never trimmed. */
  generatedReasoning?: number
  /** Cumulative generated text price over the COMPLETE log (the answers split's output side); never trimmed. */
  generatedAnswerTokens?: number
  /** Cumulative generated tool-call price over the COMPLETE log (the tool-call split's output side); never trimmed. */
  generatedCallTokens?: number
  /** Per-message allocation of reported output; retained across trimming and reset at the seed boundary. */
  billedGenerated?: OutputTokenParts
  humanInputs?: number
  answers?: number
  /** The user's newest own message as a bounded one-line preview. Last-wins: a text-less input keeps the previous line. */
  lastUser?: string
  archiveFloor?: number
  /** Bumped when a fold mutates the served detail (requests, events, live surface, archive); the slim head carries it. */
  detailRev?: number
  /** Whole-session timing totals, running sums over the COMPLETE log like `cost`. */
  timing?: TimingTotals
  /** The open step's start instant, armed by `step/start` and consumed by the following `assistant/message` and `step/end`; one slot, not
   * a map, so a hostile interleaved log degrades to skipped durations. */
  stepStart?: {
    time: number
    firstToken?: number
  }
  /** The open step's CLOSED user-wait intervals; `step/end` subtracts their clamped union from the step window to price `activeMs`, then
   * deletes the slot. */
  stepWaits?: { start: number; end: number }[]
  /** The open step's PENDING approval waits (request id → `approval/asked` instant); a crash mid-decision leaves the pair dangling, so
   * `step/end` closes the survivors at its own instant. */
  stepApprovals?: Record<string, number>
  /** The seq of the request record the open step's `assistant/message` committed — the back-pointer `step/end` stamps `activeMs` onto;
   * nothing pushes between a step's message and its end, so the stamp is an O(1) tail write. */
  stepRequestSeq?: number
  /** The timing strip's painted spans in log order, stamped with their REAL instants; idle time BETWEEN steps carries no span. Bounded by
   * TIMING_SPANS_MAX (newest tail kept). */
  spans: TimingSpan[]
  /** The open step's accumulated spans; `step/end` clamps them into the step window, de-overlaps first-wins (parallel runs paint their
   * union), fills holes with the residue kind, then deletes the slot (plain-JSON precondition). */
  stepSpans?: TimingSpan[]
  /** Tool callId → name, start instant and raw arguments, armed by `tool/call` and DELETED when its `tool/result` folds in — the map
   * stays at pending-call size instead of growing for the session's lifetime. */
  callNames: Record<string, { name: string; start: number; argsRaw?: string }>
  /** Seq list the next replacement shadows, armed by the metering event and consumed by the replacement that must follow synchronously;
   * it can differ from the replacement's declared range (pruned nodes keep their own seqs). */
  pendingShadowedSeqs?: number[]
  /** The metering event whose `tokens` the shadowed path rewrites from gross shadow price to the NET freed amount. */
  pendingShadowEventSeq?: number
  fileOps: FileOpRecord[]
  /** The newest dropped op's seq (the card's coverage floor for the served op log). */
  fileOpsFloor?: number
  /** The command log, in call order (creation at `tool/call`, settle in place at `tool/result`/`job/settled`). */
  commands: CommandStateRecord[]
  /** The newest dropped command record's seq (the panel's coverage floor). */
  commandsFloor?: number
  /** Whole-log execution tallies; each record contributes exactly once, at its running → terminal transition. */
  commandStats?: CommandStats
  /** Nested Code-Mode command records buffered by their top run_code call id until the parent's result folds
   * (same lifecycle as `pendingCodeOps`). */
  pendingCodeCmds?: Record<string, CommandStateRecord[]>
  /** Nested Code-Mode ops buffered by their top run_code call id until the parent's result folds (the dispatch events land BEFORE it).
   * Bounded by PENDING_CODE_OPS_MAX, so a hostile log that never settles a run_code cannot grow it. */
  pendingCodeOps?: Record<string, FileOpRecord[]>
}

export function trimToLastTurns(requests: RequestRecord[], maxTurns: number): RequestRecord[] {
  let runs = 0
  let start = requests.length
  let prevTurn: number | undefined
  for (let i = requests.length - 1; i >= 0; i--) {
    const turn = requests[i].turn
    if (turn !== prevTurn) {
      if (runs >= maxTurns) break
      runs++
      prevTurn = turn
    }
    start = i
  }
  return requests.slice(start)
}

export function countTurnRuns(requests: RequestRecord[]): number {
  let runs = 0
  let prevTurn: number | undefined
  for (const r of requests) {
    if (r.turn !== prevTurn) {
      runs++
      prevTurn = r.turn
    }
  }
  return runs
}

export function trimState(st: TimelineState, bounds: FoldBounds): void {
  // Trim by WHOLE turn-runs as soon as the count crosses the cap — not only when the raw step count does — so the state stays
  // deterministically at the newest ~maxKeptTurns; a threshold-only policy would oscillate.
  st.turnRuns = st.turnRuns ?? countTurnRuns(st.requests)
  if (st.turnRuns > bounds.maxKeptTurns) {
    st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns)
    st.turnRuns = countTurnRuns(st.requests)
  }
  // A hard step backstop after the turn trim, for pathological many-step turns.
  if (st.requests.length > bounds.maxRequestSteps) {
    st.requests = st.requests.slice(-bounds.maxRequestSteps)
    st.turnRuns = countTurnRuns(st.requests)
  }
  if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents)
  if (st.spans.length > TIMING_SPANS_MAX) st.spans = st.spans.slice(-TIMING_SPANS_MAX)
  if (st.fileOps.length > bounds.maxFileOps) {
    const drop = st.fileOps.length - bounds.maxFileOps
    st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, st.fileOps[drop - 1].seq)
    st.fileOps = st.fileOps.slice(drop)
  }
  if (st.commands.length > bounds.maxCommands) {
    let excess = st.commands.length - bounds.maxCommands
    let floor = 0
    // Oldest SETTLED records drop first; a running record (an in-flight or background-dispatched call) is kept.
    const kept: CommandStateRecord[] = []
    for (const rec of st.commands) {
      if (excess > 0 && rec.status !== 'running') {
        excess--
        floor = Math.max(floor, rec.seq)
        continue
      }
      kept.push(rec)
    }
    // A hostile log of never-settling calls can still overflow: then the oldest running records drop too.
    if (kept.length > bounds.maxCommands) {
      const extra = kept.length - bounds.maxCommands
      for (const rec of kept.slice(0, extra)) floor = Math.max(floor, rec.seq)
      kept.splice(0, extra)
    }
    st.commandsFloor = Math.max(st.commandsFloor ?? 0, floor)
    st.commands = kept
  }
  if (st.archived.length > 0) {
    let drop = 0
    // The entries leave in removal order, so the last dropped one's `gone` is the newest dropped seq.
    const oldestReq = st.requests.length > 0 ? st.requests[0].seq : undefined
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++
    }
    if (st.archived.length - drop > bounds.maxArchiveNodes) {
      drop = st.archived.length - bounds.maxArchiveNodes
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1].gone
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

/** A count cap, newest tail kept; at ~6-8 spans per step it covers a few hundred steps, past the strip's pixel resolution. */
const TIMING_SPANS_MAX = 2_000

export function createTimelineState(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    assistantReasoning: 0,
    assistantAnswerTokens: 0,
    assistantCallTokens: 0,
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    turnRuns: 0,
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
    commands: [],
    spans: [],
  }
}
