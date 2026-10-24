/** Shape-driven readers over the durable session-event vocabulary — the ONE place the plugin's log spellings meet. Readers stay total
 * over untrusted input (the registry drives the fold with no error boundary), and the fold reads SHAPES, never a detected harness
 * version. */

/** Whether a raw stream chunk carries a token delta; mirrors dsh-llm's `isTokenDelta`. */
export function isTokenChunk(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const c = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  switch (c.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof c.text === 'string' && c.text !== ''
    case 'tool-call-delta':
      return (typeof c.argumentsDelta === 'string' && c.argumentsDelta !== '') || c.name !== undefined
    default:
      return false
  }
}

export type DecodeKind = 'reasoning' | 'text' | 'toolarg'

export function decodeKindOfBlock(blockType: unknown): DecodeKind | undefined {
  if (blockType === 'reasoning') return 'reasoning'
  if (blockType === 'text') return 'text'
  if (blockType === 'tool-call') return 'toolarg'
  return undefined
}

export interface DecodeTally {
  spans: Record<DecodeKind, number>
  blocks: Record<DecodeKind, number>
}

/** The first token's instant inside one PACKED delta run: base time plus accumulated inter-member deltas at the first qualifying member.
 * Mirrors dsh-llm's `runFirstTokenTime`; a non-finite delta yields undefined. */
function runFirstTokenTime(record: Record<string, unknown>): number | undefined {
  const time0 = record.time0
  if (typeof time0 !== 'number' || !Number.isFinite(time0)) return undefined
  if (record.type === 'tool-call-chunks' && record.name !== undefined) return time0
  const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts
  if (!Array.isArray(fragments)) return undefined
  const dt: readonly unknown[] = Array.isArray(record.dt) ? record.dt as unknown[] : []
  let time = time0
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      const step = dt[index - 1]
      if (typeof step !== 'number' || !Number.isFinite(step)) return undefined
      time += step
    }
    if (typeof fragment === 'string' && fragment !== '') return time
  }
  return undefined
}

export interface DecodeSpan {
  kind: DecodeKind
  start: number
  end: number
}

export function firstTokenTimeOfStream(stream: unknown): number | undefined {
  // A NaN endTime disables the marker decode, leaving exactly the token scan.
  return streamTimingOf(stream, Number.NaN).firstToken
}

/** Everything one assistant stream contributes to the metering. */
export interface StreamTiming {
  firstToken?: number
  spans: DecodeSpan[]
  tally: DecodeTally
}

export function streamTimingOf(stream: unknown, endTime: number): StreamTiming {
  const tally: DecodeTally = { spans: { reasoning: 0, text: 0, toolarg: 0 }, blocks: { reasoning: 0, text: 0, toolarg: 0 } }
  const spans: DecodeSpan[] = []
  const result: StreamTiming = { spans, tally }
  if (!Array.isArray(stream)) return result
  // A non-finite endTime leaves the decode readings empty; the token scan is independent of it.
  const markersReadable = Number.isFinite(endTime)
  let firstToken: number | undefined
  let kind: DecodeKind | undefined
  let since = 0
  const close = (to: number): void => {
    if (kind === undefined || to <= since) return
    spans.push({ kind, start: since, end: to })
    tally.spans[kind] += to - since
  }
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type === 'chunk') {
      const chunk = r.chunk !== null && typeof r.chunk === 'object' ? r.chunk as { type?: unknown; blockType?: unknown } : null
      const time = r.time
      if (!Number.isFinite(time)) continue
      if (markersReadable && chunk !== null && chunk.type === 'block-start') {
        close(time as number)
        kind = decodeKindOfBlock(chunk.blockType)
        if (kind !== undefined) tally.blocks[kind] += 1
        since = time as number
      } else if (firstToken === undefined && isTokenChunk(chunk)) {
        firstToken = time as number
      }
      // A token-only read (no marker decode) is answered at the first token: nothing later can change it.
      if (!markersReadable && firstToken !== undefined) break
      continue
    }
    if (firstToken === undefined) firstToken = runFirstTokenTime(r)
    if (!markersReadable && firstToken !== undefined) break
  }
  if (markersReadable) close(endTime)
  if (firstToken !== undefined) result.firstToken = firstToken
  return result
}

/** The inclusive surface range a replacement op covers, or null for `append` and any unrecognized/hostile op (which the fold treats as an
 * append). */
export function replaceRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const { startSeq: start, endSeq: end } = op
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}
