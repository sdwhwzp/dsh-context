/** The data path shared by the Context and Fleet tabs: one hook, so the two views cannot drift apart on
 * what they read; a session with no pushed value keeps the source's cold start and retryable note. */

import type { ContextBreakdown, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'
import { contextBreakdownOf, contextPressureOf, projectionOf, tokenUsageOf, type SessionStandardProps } from './services'
import { useTimelineSource, type TimelineSource } from './timelineSource'

export interface ContextSession {
  source: TimelineSource
  data: ContextTimeline | null
  /** The key the chat's composer ring reads; absent on an older host → the caller's derived fallback. */
  pressure: ContextPressure | null
  breakdown: ContextBreakdown | null
  /** The same tally the chat stats line reads, so the figures match by construction. */
  usage: TokenUsage | null
}

export function useContextSession(props: SessionStandardProps): ContextSession {
  const source = useTimelineSource(props)
  return {
    source,
    data: source.data,
    pressure: projectionOf(props, 'contextPressure', contextPressureOf),
    breakdown: projectionOf(props, 'contextBreakdown', contextBreakdownOf),
    usage: projectionOf(props, 'tokenUsage', tokenUsageOf),
  }
}
