/** Client-visible projection units: the harness contract leaves `wire` optional (the registry's wired-register overload needs it
 * non-optional) and every unit here serves a client view; the zero-argument `init` observes neither registry argument, and
 * deriving this from the registry root inlined its `Context.sessionProjections` augmentation into the emitted `lib/index.d.ts`.
 * `tests/host/compat` pins the shape against the harness contract. */

import type { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

export interface WiredProjection<K extends keyof SessionProjectionMap, S> {
  key: K
  stateSchema: z.ZodType<S>
  init(): S
  apply(state: S, event: SessionEvent): S
  wire: {
    viewSchema: z.ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  }
  stateVersion: number
}
