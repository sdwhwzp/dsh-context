/** The command-log fold's helpers, split out of fold.ts (the file-size rule): record construction, result-marker
 * application, the exactly-once tally, and the job-event pairing. Every function is total over hostile payloads. */

import { exitOfJobDetail, markersOfText, outcomeOfMarkers, signalOfJobDetail } from '../shared/commands'
import type { CommandArgs } from '../shared/commands'
import type { CommandStateRecord, TimelineState } from './foldState'

/** A command record is found by the callId the fold armed it with (stripped before serving); a fresh call's record sits
 * at the newest end, so the scan walks backwards. */
export function findCommandIndex(commands: readonly CommandStateRecord[], callId: string): number {
  for (let i = commands.length - 1; i >= 0; i--) if (commands[i].call === callId) return i
  return -1
}

/** The text blocks of a result payload in order; the shell renderers put their markers in the single trailing text. */
export function resultTextsOf(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) return []
  const texts: string[] = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') texts.push(text)
  }
  return texts
}

/** The whole-log tally: every settled run contributes exactly once. */
export function tallyRun(st: TimelineState, rec: CommandStateRecord): void {
  const stats = { ...(st.commandStats ?? { runs: 0, failed: 0, ms: 0, bg: 0 }) }
  stats.runs += 1
  if (rec.status === 'failed' || rec.status === 'killed') stats.failed += 1
  /* v8 ignore next 1 -- every settle path stamps `end` before the running → terminal transition reaches here. */
  if (rec.end !== undefined) stats.ms += Math.max(0, rec.end - rec.start)
  st.commandStats = stats
}

/** A background dispatch counts when it is KNOWN (the run_in_background argument at creation, or the hand-off ack) —
 * a never-settling background run would otherwise never join the tally. Callers bump only on the false → true edge. */
export function bumpBg(st: TimelineState): void {
  st.commandStats = { ...(st.commandStats ?? { runs: 0, failed: 0, ms: 0, bg: 0 }), bg: (st.commandStats?.bg ?? 0) + 1 }
}

/** Replace the record at `index` (the array must already be this event's clone); the running → terminal transition
 * tallies the run. */
export function setCommand(st: TimelineState, index: number, next: CommandStateRecord): void {
  if (st.commands[index].status === 'running' && next.status !== 'running') tallyRun(st, next)
  st.commands[index] = next
}

/** The marker/display fields a result payload contributes, shared by the native settle and the PTC one. */
function resultPatchOf(texts: string[], markers: ReturnType<typeof markersOfText>): Partial<CommandStateRecord> {
  return {
    ...(texts.length > 0 ? { outChars: texts.reduce((n, t) => n + t.length, 0) } : {}),
    ...(markers.truncated === true ? { outTruncated: true as const } : {}),
    ...(markers.stderr === true ? { stderr: true as const } : {}),
    ...(markers.timedOut === true ? { timedOut: true as const } : {}),
    ...(markers.stopped === true ? { stopped: true as const } : {}),
    ...(markers.denied === true ? { denied: true as const } : {}),
    ...(markers.signal !== undefined ? { signal: markers.signal } : {}),
    ...(markers.exit !== undefined ? { exit: markers.exit } : {}),
  }
}

/** Result envelopes refine display facts but cannot replace a precise job outcome. */
export function settleCommandResult(prev: CommandStateRecord, texts: string[], isError: boolean, time: number): CommandStateRecord {
  const markers = markersOfText(texts.at(-1) ?? '')
  const patch = resultPatchOf(texts, markers)
  const { exit: _exit, signal: _signal, ...display } = patch
  const next: CommandStateRecord = { ...prev, ...(prev.status === 'running' ? patch : display), err: isError }
  if (markers.backgroundAck === true) next.background = true
  else if (prev.status === 'running') {
    const outcome = outcomeOfMarkers(markers, isError)
    next.status = outcome.status
    if (prev.tool !== 'run_code') {
      if (outcome.exit !== undefined) next.exit = outcome.exit
      if (outcome.exitInferred === true) next.exitInferred = true
      else delete next.exitInferred
    }
    next.end = time
    next.derived = true
  }
  return next
}

/** The running record at call/dispatch-start time, built identically for a top-level call and a nested PTC dispatch. */
export function commandRecordOf(input: {
  seq: number
  time: number
  tool: CommandStateRecord['tool']
  parsed: CommandArgs & { truncated?: true }
  turn?: unknown
  step?: unknown
  codeMode?: true
  call: string
}): CommandStateRecord {
  const { parsed } = input
  return {
    seq: input.seq,
    time: input.time,
    tool: input.tool,
    cmd: parsed.cmd,
    ...(parsed.truncated === true ? { cmdTruncated: true as const } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.background === true ? { background: true as const } : {}),
    ...(parsed.sandbox !== undefined ? { sandbox: parsed.sandbox } : {}),
    ...(typeof input.turn === 'number' ? { turn: input.turn } : {}),
    ...(typeof input.step === 'number' ? { step: input.step } : {}),
    ...(input.codeMode === true ? { codeMode: true as const } : {}),
    start: input.time,
    status: 'running',
    err: false,
    call: input.call,
  }
}

/** A job event's creating tool call id, when it carries one. */
export function jobCallIdOf(data: Record<string, unknown> | undefined): string | undefined {
  const toolCall = data?.toolCall
  if (toolCall === null || typeof toolCall !== 'object') return undefined
  const callId = (toolCall as { callId?: unknown }).callId
  return typeof callId === 'string' ? callId : undefined
}

/** A settled job's outcome as a record patch: precise end, mapped status (a nonzero command exit rides `completed`
 * with the code in the detail — the shell tools never call it `failed`), and the detail's exit/signal. */
export function jobOutcomePatch(
  prev: CommandStateRecord,
  status: 'completed' | 'killed' | 'failed',
  finishedAt: number,
  detail: unknown,
): CommandStateRecord {
  const exit = exitOfJobDetail(detail)
  const signal = signalOfJobDetail(detail)
  const next: CommandStateRecord = {
    ...prev,
    end: finishedAt,
    status: status === 'completed' ? (exit !== undefined && exit !== 0 ? 'failed' : 'completed') : status,
    ...(exit !== undefined ? { exit } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }
  delete next.derived
  // The job outcome is precise: any earlier envelope-inferred exit yields to it, whether or not the detail carries a code.
  delete next.exitInferred
  return next
}

/** Apply `patch` to a buffered nested record by its subCallId (a nested run's job events can land while the record
 * still waits for the run_code root's result). Replaces, never mutates; returns whether one matched. */
export function patchBufferedCommand(
  st: TimelineState,
  pending: Record<string, CommandStateRecord[]>,
  callId: string,
  patch: (rec: CommandStateRecord) => CommandStateRecord,
): boolean {
  for (const root in pending) {
    const idx = pending[root].findIndex(r => r.call === callId)
    if (idx < 0) continue
    const list = [...pending[root]]
    list[idx] = patch(list[idx])
    st.pendingCodeCmds = { ...pending, [root]: list }
    return true
  }
  return false
}
