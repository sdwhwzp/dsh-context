import type { OutputTokenParts, Category, ContextBreakdown, RequestRecord, Snapshot, TokenUsage } from '../shared/types'

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

/** The timing card's reasoning hue, so both thinking surfaces read as one category. */
const THINKING_COLOR = 'var(--color-violet-500)'

/** The timing card's reply hue, so both answers surfaces read as one category. */
const ANSWERS_COLOR = 'var(--color-pink-500)'

const countOf = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

/** The billed ring's canonical order: the Token card and the overview aggregate share it, so Answers always closes. */
export const RING_ORDER: readonly string[] = ['system', 'tools', 'user', 'inject', 'skill', 'modelContent', 'toolCalls', 'thinking', 'answers']

/** The generated assistant content, as the fold's own block prices. */
export interface GeneratedTokens {
  reasoning?: number
  answers?: number
  calls?: number
  billed?: OutputTokenParts
  unsplit?: boolean
}

/** The Token card's billed split: shares follow the assistant's content ratios on both the prompt and generated sides, so
 * framing never lands on Tool Calls and the parts total the chat line's count. A row without the split fields (an older
 * host, or foreign data) keeps the historic Tool Calls home. */
export function billedParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
  usage: TokenUsage,
  generated: GeneratedTokens = {},
): PartsPart[] {
  const input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const output = countOf(usage.outputTokens)
  const estimated = officialParts(current, breakdown)
  const prompt = input > 0
    ? anchoredParts(estimated, input)
    : estimated.map(p => ({ ...p, value: 0 }))
  if (generated.unsplit) {
    const assistant = prompt.reduce((sum, p) => p.key === 'assistant' ? sum + p.value : sum, 0)
    return [
      ...prompt.filter(p => p.key !== 'assistant').map(p => p.key === 'tool' ? { ...p, key: 'toolCalls' } : p),
      { key: 'modelContent', color: CAT_COLOR.assistant, value: assistant + output },
    ]
  }
  const liveAssistant = countOf(current.assistant)
  const liveReasoning = Math.min(countOf(current.assistantReasoning), liveAssistant)
  const liveAnswers = Math.min(countOf(current.assistantAnswerTokens), liveAssistant - liveReasoning)
  const liveCalls = Math.min(countOf(current.assistantCallTokens), liveAssistant - liveReasoning - liveAnswers)
  const liveContent = liveReasoning + liveAnswers + liveCalls
  const genReasoning = countOf(generated.reasoning)
  const genAnswers = countOf(generated.answers)
  const genCalls = countOf(generated.calls)
  let promptThinking = 0
  let promptAnswers = 0
  let promptCalls = 0
  let promptToolResults = 0
  const parts: PartsPart[] = []
  for (const p of prompt) {
    if (p.key === 'assistant') {
      const nonCall = liveContent > 0
        ? Math.min(p.value, Math.round((liveReasoning + liveAnswers) / liveContent * p.value))
        : 0
      promptThinking = liveContent > 0 ? Math.min(nonCall, Math.round(liveReasoning / liveContent * p.value)) : 0
      promptAnswers = nonCall - promptThinking
      promptCalls = Math.max(0, liveContent > 0 ? p.value - nonCall : p.value)
      continue
    }
    if (p.key === 'tool') promptToolResults = p.value
    parts.push(p)
  }
  const genThinking = Math.min(genReasoning, output)
  const nonThinking = output - genThinking
  const genNonThinking = genAnswers + genCalls
  let outThinking = genThinking
  let outAnswers = 0
  let outCalls = 0
  let unclassified = 0
  if (generated.billed !== undefined) {
    outThinking = Math.min(countOf(generated.billed.reasoning), output)
    outAnswers = Math.min(countOf(generated.billed.answers), output - outThinking)
    outCalls = Math.min(countOf(generated.billed.calls), output - outThinking - outAnswers)
    unclassified = output - outThinking - outAnswers - outCalls
  } else if (genNonThinking > 0) {
    outAnswers = Math.round(nonThinking * genAnswers / genNonThinking)
    outCalls = nonThinking - outAnswers
  } else if (genThinking > 0) {
    outThinking = output
  } else {
    outCalls = nonThinking
  }
  return [
    ...parts.map(p => p.key === 'tool' ? { ...p, key: 'toolCalls', value: promptToolResults + promptCalls + outCalls } : p),
    ...(unclassified > 0 ? [{ key: 'modelContent', color: CAT_COLOR.assistant, value: unclassified }] : []),
    { key: 'thinking', color: THINKING_COLOR, value: promptThinking + outThinking },
    { key: 'answers', color: ANSWERS_COLOR, value: promptAnswers + outAnswers },
  ]
}
