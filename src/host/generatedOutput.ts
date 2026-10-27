import type { OutputTokenParts } from '../shared/types'

/** Allocate reported output using content prices, preserving an explicitly reported reasoning count. */
export function outputParts(
  output: number, reasoning: number, answers: number, calls: number, reportedReasoning: number | null,
): OutputTokenParts {
  const total = reasoning + answers + calls
  const thinking = reportedReasoning !== null
    ? Math.min(reportedReasoning, output)
    : total > 0 ? Math.min(output, Math.round(reasoning / total * output)) : 0
  const remaining = output - thinking
  const nonThinking = answers + calls
  const reply = nonThinking > 0 ? Math.min(remaining, Math.round(answers / nonThinking * remaining)) : 0
  const toolCalls = nonThinking > 0 ? remaining - reply : 0
  return { reasoning: thinking, answers: reply, calls: toolCalls, unclassified: remaining - reply - toolCalls }
}
