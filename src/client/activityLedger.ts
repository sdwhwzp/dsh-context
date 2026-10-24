import type { ActivityDay, ContextActivity } from '../shared/types'
import { asRecord, costOf } from './wireValues'

/** Absent stays null (an older host serves no such key). ONE pass decides per DAY: a well-formed day rides by
 * reference, a repairable one is rebuilt, an unreadable one drops — and the day map is copied only once a repair makes
 * that necessary. The repair is deterministic: a host that once served a malformed fee or tally gets it scrubbed here
 * regardless of what its sibling days look like. */
export function activityOf(value: unknown): ContextActivity | null {
  const data = asRecord(value)
  if (data === null) return null
  const rawDays = asRecord(data.days)
  if (rawDays === null || Array.isArray(rawDays)) return null
  let drops: Set<string> | null = null
  let fixes: Map<string, ActivityDay> | null = null
  for (const key in rawDays) {
    // Inherited keys never took part in the walk; skip, never repair.
    if (!Object.hasOwn(rawDays, key)) continue
    const repaired = dayEntryOf(key, rawDays[key])
    if (repaired === undefined) (drops ??= new Set()).add(key)
    else if (repaired !== rawDays[key]) (fixes ??= new Map()).set(key, repaired)
  }
  if (drops === null && fixes === null) return data as unknown as ContextActivity
  // Rebuilt only for a real repair — a dynamic `delete` would deopt the kept record.
  const days: Record<string, ActivityDay> = {}
  for (const key of Object.keys(rawDays)) {
    if (drops?.has(key) === true) continue
    days[key] = fixes?.get(key) ?? rawDays[key] as ActivityDay
  }
  return { days }
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** A day's served entry, or `undefined` when the day drops. A well-formed day returns ITSELF (the identity marks
 * "nothing to repair"); anything else is rebuilt into a plain entry. */
function dayEntryOf(key: string, raw: unknown): ActivityDay | undefined {
  const entry = asRecord(raw)
  const tokens = entry?.tokens
  const requests = entry?.requests
  if (!DAY_KEY.test(key)
    || entry === null || Array.isArray(entry)
    || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0
    || typeof requests !== 'number' || !Number.isFinite(requests) || requests < 0) {
    return undefined
  }
  const turns = nonNegativeOf(entry.turns)
  const toolCalls = nonNegativeOf(entry.toolCalls)
  const toolsMs = nonNegativeOf(entry.toolsMs)
  const wallMs = nonNegativeOf(entry.wallMs)
  const clean = costWellFormed(entry.cost)
    && skillTalliesWellFormed(entry.skills)
    && (entry.turns === undefined || turns !== undefined)
    && (entry.toolCalls === undefined || toolCalls !== undefined)
    && (entry.toolsMs === undefined || toolsMs !== undefined)
    && (entry.wallMs === undefined || wallMs !== undefined)
  if (clean) return entry as unknown as ActivityDay
  const costRaw = costOf(entry.cost)
  const cost = costRaw !== undefined && Object.keys(costRaw).length > 0 ? costRaw : undefined
  const skills = skillTalliesOf(entry.skills)
  return {
    tokens,
    requests,
    ...(cost !== undefined ? { cost } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolsMs !== undefined ? { toolsMs } : {}),
    ...(wallMs !== undefined ? { wallMs } : {}),
    ...(skills !== undefined ? { skills } : {}),
  }
}

function nonNegativeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Every level and present field of a fee must already hold its served shape: a non-record level, or a present
 * bucket field that is not a finite number, needs the repair pass. */
function costWellFormed(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  let any = false
  for (const provider in data) {
    if (!Object.hasOwn(data, provider)) continue
    const models = asRecord(data[provider])
    if (models === null || Array.isArray(models)) return false
    any = true
    for (const model in models) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) return false
      for (const period of ['peak', 'off'] as const) {
        const raw = periods[period]
        if (raw === undefined) continue
        const bucket = asRecord(raw)
        if (bucket === null || Array.isArray(bucket)) return false
        for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output']) {
          const v = bucket[k]
          if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return false
        }
      }
    }
  }
  // An empty fee record carries no figure: the repair drops it (as the old dirty path did).
  return any
}

/** Every own tally must hold a served shape, and an empty table is not served at all (the repair drops it). */
function skillTalliesWellFormed(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  let any = false
  for (const name in data) {
    if (!Object.hasOwn(data, name)) continue
    const tally = asRecord(data[name])
    const n = tally?.n
    const last = tally?.last
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false
    if (typeof last !== 'number' || !Number.isFinite(last)) return false
    any = true
  }
  return any
}

/** True when a cost usage record is already in the merged shape a `mergeCostUsage` output would take — every own
 * level a record and every present bucket carrying all four finite fields, with at least one bucket — so aliasing it
 * equals re-merging it. Anything else must go through the merge's zero-filling rebuild. */
export function costFullyQuantified(value: unknown): boolean {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  let any = false
  for (const provider of Object.keys(data)) {
    // A JSON-parsed own `__proto__` key reads through the prototype, so the merge this aliases would have dropped it.
    if (provider === '__proto__') return false
    const models = asRecord(data[provider])
    if (models === null || Array.isArray(models)) return false
    for (const model of Object.keys(models)) {
      if (model === '__proto__') return false
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) return false
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output']) {
          const v = bucket[k]
          if (typeof v !== 'number' || !Number.isFinite(v)) return false
        }
        any = true
      }
    }
  }
  return any
}

function skillTalliesOf(value: unknown): ActivityDay['skills'] | undefined {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return undefined
  const skills: Record<string, { n: number; last: number }> = {}
  let any = false
  for (const name of Object.keys(data)) {
    const tally = asRecord(data[name])
    const n = tally?.n
    const last = tally?.last
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0
      || typeof last !== 'number' || !Number.isFinite(last)) continue
    skills[name] = { n, last }
    any = true
  }
  return any ? skills : undefined
}

