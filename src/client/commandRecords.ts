import type { CommandRecord } from '../shared/types'

const STATUSES: ReadonlySet<unknown> = new Set(['running', 'completed', 'failed', 'killed'])
const FLAG_KEYS = ['cmdTruncated', 'background', 'codeMode', 'exitInferred', 'timedOut', 'stopped', 'denied', 'outTruncated', 'stderr', 'derived'] as const
const NUM_KEYS = ['resultSeq', 'parent', 'turn', 'step', 'end', 'exit', 'outChars', 'timeoutMs', 'gone'] as const
const STR_KEYS = ['description', 'cwd', 'sandbox', 'signal'] as const

type CommandCore = Pick<CommandRecord, 'seq' | 'time' | 'start' | 'tool' | 'status' | 'err'>

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasCommandCore(value: unknown): value is CommandCore & Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return isFiniteNumber(record.seq) && isFiniteNumber(record.time) && isFiniteNumber(record.start)
    && typeof record.tool === 'string' && typeof record.err === 'boolean' && STATUSES.has(record.status)
}

export function isCommandRecord(value: unknown): value is CommandRecord {
  try {
    return hasCommandCore(value)
      && (value.cmd === undefined || typeof value.cmd === 'string')
      && STR_KEYS.every(key => value[key] === undefined || typeof value[key] === 'string')
      && NUM_KEYS.every(key => value[key] === undefined || isFiniteNumber(value[key]))
      && FLAG_KEYS.every(key => value[key] === undefined || value[key] === true)
  } catch {
    return false
  }
}

export function pageCommandOf(value: unknown): CommandRecord | null {
  try {
    if (!hasCommandCore(value) || typeof value.cmd !== 'string') return null
    const { seq, time, tool, cmd, start, status, err } = value
    const record: CommandRecord = { seq, time, tool, cmd, start, status, err }
    for (const key of NUM_KEYS) {
      const field = value[key]
      if (isFiniteNumber(field)) record[key] = field
    }
    for (const key of STR_KEYS) {
      const field = value[key]
      if (typeof field === 'string') record[key] = field
    }
    for (const key of FLAG_KEYS) if (value[key] === true) record[key] = true
    return record
  } catch {
    return null
  }
}

export function commandRecordsOf(value: unknown): CommandRecord[] {
  return Array.isArray(value) ? value.filter(isCommandRecord) : []
}
