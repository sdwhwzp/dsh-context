import type { CommandRecord } from '../shared/types'

/** Invalid wire entries drop independently so one damaged run cannot unmount the command panel. */
export function isCommandRecord(value: unknown): value is CommandRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const record = value as Record<string, unknown>
    if (!['seq', 'time', 'start'].every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))) return false
    if (typeof record.tool !== 'string' || typeof record.cmd !== 'string' || typeof record.err !== 'boolean') return false
    if (typeof record.status !== 'string' || !['running', 'completed', 'failed', 'killed'].includes(record.status)) return false
    if (!['description', 'cwd', 'sandbox', 'signal'].every(key => record[key] === undefined || typeof record[key] === 'string')) return false
    if (!['resultSeq', 'timeoutMs', 'parent', 'turn', 'step', 'end', 'exit', 'outChars', 'gone']
      .every(key => record[key] === undefined || (typeof record[key] === 'number' && Number.isFinite(record[key])))) return false
    return ['cmdTruncated', 'background', 'codeMode', 'exitInferred', 'timedOut', 'stopped', 'denied', 'outTruncated', 'stderr', 'derived']
      .every(key => record[key] === undefined || record[key] === true)
  } catch {
    return false
  }
}

export function commandRecordsOf(value: unknown): CommandRecord[] {
  return Array.isArray(value) ? value.filter(isCommandRecord) : []
}
