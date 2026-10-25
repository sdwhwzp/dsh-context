/** The command panel's coloring: the harness's own shiki highlighter, bound to the grammar a record's shell tool
 * names, over a text-keyed cache and a per-line cost guard. */

import { commandTool } from '../shared/commands'
import { lruTouch, lruTrim } from './lru'
import type { CodeHighlighter, HighlightSpan } from '@deepseek-ai/dsh-client-ui-primitives'

/** The two grammars the panel colors with; every other tool's text stays plain. A `run_code` program names no language
 * (its runtime is TypeScript or Python), so no one grammar can color it without lying about the other. */
export type ShellGrammar = 'bash' | 'powershell'

const GRAMMARS: Partial<Record<string, ShellGrammar>> = { bash: 'bash', pwsh: 'powershell' }

/** The grammar for a record's tool, or `undefined` for text that renders plain. */
export function grammarOfTool(tool: string): ShellGrammar | undefined {
  const kind = commandTool(tool)
  return kind === null ? undefined : GRAMMARS[kind]
}

/** Past this many UTF-16 units on ONE line the whole text renders plain: the tokenizer's JavaScript regex engine
 * costs hundreds of ms on a multi-thousand-unit line, and the fold's command cap reaches tens of thousands of
 * characters. The harness caps one line the same way only from `0.2.1` on, so this guard is the floor line's alone. */
const MAX_LINE_CHARS = 1000
const LONG_LINE = new RegExp(`^.{${MAX_LINE_CHARS + 1},}`, 'm')

/** Token runs per (grammar, text), newest last. The panel re-renders on every keystroke and projection refresh, so a
 * cached text keeps the tokenizer off the render path; the cap covers the retained command log's order of magnitude. */
const runs = new Map<string, readonly HighlightSpan[][]>()
const RUNS_MAX = 600

/** The text's token runs, or `undefined` to render plain — an over-long line, an unmapped tool, or a lazy grammar
 * still loading. A loading grammar's `undefined` is never cached (the next call must re-attempt it); a tokenized
 * text keeps its runs until the LRU drops them. */
export function highlightRuns(highlight: CodeHighlighter, grammar: ShellGrammar, text: string): readonly HighlightSpan[][] | undefined {
  if (LONG_LINE.test(text)) return undefined
  const key = grammar + '\u0000' + text
  const hit = runs.get(key)
  if (hit !== undefined) {
    lruTouch(runs, key)
    return hit
  }
  const value = highlight(text)
  if (value !== undefined) {
    runs.set(key, value)
    lruTrim(runs, RUNS_MAX)
  }
  return value
}
