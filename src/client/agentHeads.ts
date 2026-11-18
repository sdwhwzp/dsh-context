import { useCallback, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { DETAIL_ROUTE, HEADS_ROUTE } from './apiRoutes'
import { byteSizeOf } from './boundedCache'
import { subscribeInvalidations } from './invalidation'
import { registerRetentionCleanup, makeRetentionCache } from './retention'
import { noteCostPending } from './costRefresh'
import { postRoute } from './route'
import { asRecord, timelineOf } from './services'
import { clientScopeOf, subscribeClientScope } from './timelineSource'

export interface AgentHeads {
  headOf(id: string): Promise<ContextTimeline | null>
  headOfMany?(ids: readonly string[]): Promise<ReadonlyMap<string, ContextTimeline>>
}

export function makeHeadFetcher(sessionId: string, signal?: AbortSignal): (() => Promise<ContextTimeline | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(
    DETAIL_ROUTE,
    { sessionId, head: true },
    value => timelineOf(asRecord(value)?.head),
    { label: 'head', signal },
  )
}

export function headsOf(value: unknown): Map<string, ContextTimeline> | null {
  const data = asRecord(value)
  if (data === null) return null
  const out = new Map<string, ContextTimeline>()
  for (const id of Object.keys(data)) {
    const entry = asRecord(data[id])
    const head = entry === null ? null : timelineOf(entry.head)
    if (head !== null) out.set(id, head)
  }
  return out
}

export function makeBatchHeadFetcher(ids: readonly string[], signal?: AbortSignal): () => Promise<Map<string, ContextTimeline> | null> {
  return () => postRoute(HEADS_ROUTE, { ids }, headsOf, { label: 'heads', signal })
}

export async function readHeads(heads: AgentHeads, ids: readonly string[]): Promise<ReadonlyMap<string, ContextTimeline>> {
  if (heads.headOfMany !== undefined) return heads.headOfMany(ids)
  const result = new Map<string, ContextTimeline>()
  const reads = await Promise.allSettled(ids.map(async id => ({ id, head: await heads.headOf(id) })))
  let failure: unknown
  for (const read of reads) {
    if (read.status === 'rejected') {
      failure = failure ?? read.reason
      continue
    }
    if (read.value.head !== null) result.set(read.value.id, read.value.head)
  }
  if (failure !== undefined) throw new Error(failure instanceof Error ? failure.message : 'heads read failed')
  return result
}

const HEAD_BATCH_SIZE = 64

const HEAD_DETAIL_FALLBACK_MAX = 64

const HEAD_DETAIL_FALLBACK_CONCURRENCY = 4

interface HeadEntry {
  promise: Promise<ContextTimeline | null>
  bytes: number
}

export function makeAgentHeads(): AgentHeads {
  const heads = makeRetentionCache<string, HeadEntry>('agentHeads', { sizeOf: entry => entry.bytes })
  const inflight = new Map<string, HeadEntry>()
  let generation = 0
  const clear = (): void => {
    generation++
    heads.clear()
    inflight.clear()
  }
  const offScope = subscribeClientScope(clear)
  const offInvalidation = subscribeInvalidations((event) => {
    if (event.kind === 'pricing') {
      clear()
      return
    }
    if (event.kind !== 'heads') return
    const id = event.sessionId
    if (id === undefined) {
      clear()
      return
    }
    generation++
    heads.delete(id)
    inflight.delete(id)
  })
  registerRetentionCleanup(() => {
    generation++
    inflight.clear()
    heads.dispose()
    offScope()
    offInvalidation()
  })
  const track = (id: string, scope: AbortSignal, pending: Promise<ContextTimeline | null>): HeadEntry => {
    const entry: HeadEntry = { promise: Promise.resolve(null), bytes: 0 }
    const startedAt = generation
    entry.promise = pending.then((head) => {
      if (inflight.get(id) === entry) inflight.delete(id)
      if (scope.aborted) return null
      if (startedAt === generation) {
        entry.bytes = head === null ? 0 : byteSizeOf(head)
        heads.set(id, entry)
      }
      noteCostPending(head?.costRead)
      return head
    }, (error: unknown) => {
      if (inflight.get(id) === entry) inflight.delete(id)
      if (scope.aborted) return null
      throw error
    })
    inflight.set(id, entry)
    return entry
  }
  return {
    headOf(id: string): Promise<ContextTimeline | null> {
      const scope = clientScopeOf()
      if (scope === null) return Promise.resolve(null)
      const cached = heads.get(id)
      if (cached !== undefined) return cached.promise
      const running = inflight.get(id)
      if (running !== undefined) return running.promise
      const fetcher = makeHeadFetcher(id, scope)
      return track(id, scope, fetcher !== undefined ? fetcher() : Promise.resolve(null)).promise
    },
    async headOfMany(ids: readonly string[]): Promise<ReadonlyMap<string, ContextTimeline>> {
      const scope = clientScopeOf()
      const result = new Map<string, ContextTimeline>()
      if (scope === null) return result
      const isCurrent = (): boolean => !scope.aborted
      const needed: string[] = []
      const seen = new Set<string>()
      for (const id of ids) {
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const entry = heads.get(id) ?? inflight.get(id)
        if (entry !== undefined) {
          const head = await entry.promise
          if (!isCurrent()) return new Map()
          if (head !== null) result.set(id, head)
          continue
        }
        needed.push(id)
      }
      const entries = new Map<string, HeadEntry>()
      for (let offset = 0; offset < needed.length; offset += HEAD_BATCH_SIZE) {
        const chunk = needed.slice(offset, offset + HEAD_BATCH_SIZE)
        const pending = makeBatchHeadFetcher(chunk, scope)()
        for (const id of chunk) {
          const entry = track(id, scope, pending.then(batch => batch?.get(id) ?? null))
          entries.set(id, entry)
        }
      }
      const outcomes = await Promise.allSettled([...entries].map(async ([id, entry]) => ({ id, head: await entry.promise })))
      if (!isCurrent()) return new Map()
      let failure: unknown
      const missing: string[] = []
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          failure = failure ?? outcome.reason
          continue
        }
        if (outcome.value.head !== null) result.set(outcome.value.id, outcome.value.head)
        else missing.push(outcome.value.id)
      }
      const fallbacks = missing.slice(0, HEAD_DETAIL_FALLBACK_MAX)
      for (let offset = 0; offset < fallbacks.length; offset += HEAD_DETAIL_FALLBACK_CONCURRENCY) {
        const chunk = fallbacks.slice(offset, offset + HEAD_DETAIL_FALLBACK_CONCURRENCY)
        const reads = await Promise.allSettled(chunk.map(async (id) => {
          const startedAt = generation
          const head = await (makeHeadFetcher(id, scope) as () => Promise<ContextTimeline | null>)()
          if (head === null || !isCurrent()) return { id, head: null }
          if (startedAt === generation) {
            const entry: HeadEntry = { promise: Promise.resolve(head), bytes: byteSizeOf(head) }
            heads.set(id, entry)
          }
          return { id, head }
        }))
        if (!isCurrent()) return new Map()
        for (const read of reads) {
          if (read.status === 'rejected') continue
          if (read.value.head !== null) result.set(read.value.id, read.value.head)
        }
      }
      if (failure !== undefined) throw new Error(failure instanceof Error ? failure.message : 'heads read failed')
      return result
    },
  }
}

export function useSessionsSnapshot(face: SessionsFaceLike | null, coalesceMs = 0): unknown {
  const subscribe = useCallback((fn: () => void) => {
    if (face === null) return () => {}
    /* v8 ignore next 2 */
    if (face.list === undefined) return () => {}
    if (coalesceMs <= 0) return face.list.subscribe(fn)
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = face.list.subscribe(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        fn()
      }, coalesceMs)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [face, coalesceMs])
  const getSnapshot = useCallback(() => {
    if (face === null) return null
    /* v8 ignore next 2 */
    if (face.list === undefined) return null
    return face.list.getSnapshot()
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}
