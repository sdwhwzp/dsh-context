import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionCostUsage } from '../../shared/types'
import { connectionGenerationStoreOf, sessionSpendOf, type ClientCtx, type SessionSpend } from '../dshFaces'

export function useSessionSpend(
  ctx: ClientCtx,
  sessionId: string | undefined,
  cost: SessionCostUsage | undefined,
): SessionSpend | null {
  const connection = useMemo(() => connectionGenerationStoreOf(ctx), [ctx])
  const generation = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  const scope = useMemo(() => ({ ctx, sessionId, generation }), [ctx, sessionId, generation])
  const [quote, setQuote] = useState<{ scope: typeof scope; value: SessionSpend } | null>(null)
  useEffect(() => { setQuote(null) }, [scope])
  useEffect(() => {
    const { ctx, sessionId, generation } = scope
    if (sessionId === undefined || generation === null) return
    const controller = new AbortController()
    void sessionSpendOf(ctx, sessionId, controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setQuote(value !== null && value.cost !== null ? { scope, value } : null)
    })
    return () => { controller.abort() }
  }, [scope, cost])
  return quote?.scope === scope ? quote.value : null
}
