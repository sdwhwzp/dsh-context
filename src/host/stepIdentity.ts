/** Step-boundary message identity guard: the harness refuses to LOAD a session whose durable log carries a
 * `user/message` without a non-empty string `id`, while the runtime append path runs no such check — one unidentified
 * message persists silently and bricks the session at its next load. The prepended `agent/pre-step` listener sees the
 * final message list and fails open on any unexpected shape. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

const MINTED_ID_PREFIX = 'dshctx-'

export interface PreStepDecision {
  kind?: unknown
  messages?: unknown[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      this: Context,
      input: { agent: unknown; messages: unknown[]; signal: AbortSignal; step: number; turn: number },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

/** Whether the message fails the harness's restore-time identity check; non-object entries are unfixable. */
function lacksId(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const id = (message as { id?: unknown }).id
  return typeof id !== 'string' || id === ''
}

/** Mint ids only for would-persist-unidentified messages; untouched entries pass by reference, undefined = none needed. */
export function identifiedMessages(messages: readonly unknown[]): unknown[] | undefined {
  let copy: unknown[] | undefined
  for (const [index, message] of messages.entries()) {
    if (!lacksId(message)) {
      copy?.push(message)
      continue
    }
    copy ??= messages.slice(0, index)
    copy.push({ ...(message as object), id: MINTED_ID_PREFIX + randomUUID() })
  }
  return copy
}

export function watchStepIdentity(ctx: Context): void {
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const identified = identifiedMessages(decision.messages)
      return identified === undefined
        ? decision
        : { ...decision, messages: identified }
    } catch {
      return decision
    }
  }, { prepend: true })
}
