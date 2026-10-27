import type { Category, ContextBreakdown, RequestRecord, Snapshot, TokenUsage } from '../shared/types'

export interface PartsPart {
  key: string
  color: string
  value: number
  /** Heuristic count shown by the legend and tooltips (defaults to value). */
  raw?: number
  label?: string
  /** Shared-hover group: a hover key equal to a part's group lights it. */
  group?: string
}

export const CATS: { key: Category | 'system' | 'tools'; color: string }[] = [
  { key: 'system', color: 'var(--color-indigo-500)' },
  { key: 'tools', color: 'var(--color-amber-500)' },
  { key: 'user', color: 'var(--color-green-500)' },
  { key: 'inject', color: 'var(--color-purple-500)' },
  { key: 'skill', color: 'var(--color-orange-500)' },
  { key: 'assistant', color: 'var(--color-blue-500)' },
  { key: 'tool', color: 'var(--color-teal-500)' },
]

export const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.key, c.color])) as Record<Category | 'system' | 'tools', string>

/** The message-fold categories in canonical order — `CATS` without the singular `system`/`tools` bands. */
export const MESSAGE_CATS: readonly (Category | 'system' | 'tools')[] = ['user', 'inject', 'skill', 'assistant', 'tool']

export function partsOf(breakdown: Snapshot['current'] | RequestRecord): PartsPart[] {
  return CATS.map((c) => {
    return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
  })
}

/** Pie-consistent raw parts from the OFFICIAL `contextBreakdown` when delivered, else the fold's own sums. */
export function officialParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
): PartsPart[] {
  const foldSurface = current.user + current.inject + current.skill + current.assistant + current.tool
  const system = breakdown?.systemTokens ?? current.system
  const tools = breakdown?.toolsTokens ?? current.tools
  const messages = breakdown?.messageTokens ?? foldSurface
  const shares: Record<string, number> = { system, tools }
  if (foldSurface > 0) {
    let assigned = 0
    let largest: Category = 'user'
    for (const cat of MESSAGE_CATS) {
      const count = Math.round(messages * (current[cat as Category] / foldSurface))
      shares[cat] = count
      assigned += count
      if (current[cat as Category] > current[largest]) largest = cat as Category
    }
    // Rounding residue lands on the largest category; the clamp keeps a tiny bucket from going negative.
    shares[largest] = Math.max(0, shares[largest] + messages - assigned)
  } else {
    for (const cat of MESSAGE_CATS) shares[cat] = 0
  }
  return CATS.map(c => ({
    key: c.key,
    color: c.color,
    /** v8 ignore next 1 -- `shares` is initialized with system/tools and both
     * foldSurface arms assign every MESSAGE_CATS key, so each key is always defined; the fallback is defensive. */
    value: shares[c.key] ?? 0,
  }))
}

/** Round cumulative heuristic shares so the integer parts preserve the rounded provider total. */
export function anchoredParts(parts: PartsPart[], target: number | null): PartsPart[] {
  const sourced = parts.map(p => ({ ...p, raw: p.raw ?? p.value }))
  if (target === null || target <= 0) return sourced
  let total = 0
  for (const p of sourced) total += p.raw
  if (total <= 0) return sourced
  if (total === target) return sourced.map(p => ({ ...p, value: p.raw }))
  let cumulative = 0
  let assigned = 0
  return sourced.map((p, index) => {
    cumulative += p.raw
    const through = index === sourced.length - 1
      ? Math.round(target)
      : Math.min(Math.round(target), Math.round(cumulative / total * target))
    const value = through - assigned
    assigned = through
    return { ...p, value }
  })
}

/** The thinking slice reuses the retired output slice's hue. */
const THINKING_COLOR = 'var(--color-pink-500)'

const countOf = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

/** The Token card's billed split: composition categories share the provider prompt total; the assistant bucket's live
 * reasoning share and the generated reasoning count move into a closing thinking slice, and the non-thinking remainder
 * stays on assistant. The parts total the chat line's count by construction. */
export function billedParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
  usage: TokenUsage,
  generatedReasoning = 0,
): PartsPart[] {
  const input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const output = countOf(usage.outputTokens)
  const estimated = officialParts(current, breakdown)
  const prompt = input > 0
    ? anchoredParts(estimated, input)
    : estimated.map(p => ({ ...p, value: 0 }))
  const liveAssistant = countOf(current.assistant)
  const liveReasoning = Math.min(countOf(current.assistantReasoning), liveAssistant)
  const generatedThinking = Math.min(countOf(generatedReasoning), output)
  let promptThinking = 0
  const parts = prompt.map((p) => {
    if (p.key !== 'assistant') return p
    promptThinking = liveAssistant > 0 ? Math.round(p.value * liveReasoning / liveAssistant) : 0
    return { ...p, value: p.value - promptThinking + output - generatedThinking }
  })
  return [...parts, { key: 'thinking', color: THINKING_COLOR, value: promptThinking + generatedThinking }]
}
