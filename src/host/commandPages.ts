/** The paged full command log behind the command card's incremental history fill. The projection state keeps only the
 * newest `maxCommands` records (the wire and checkpoint stay bounded), so an older page folds the complete observed log
 * through the SAME reducer, cached and extended in place: every page is the fold's own record, never a re-parse. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandPage } from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import type { FoldBounds } from './config'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import type { CommandStateRecord, TimelineState } from './foldState'
import { serveCommand } from './foldWire'

export const COMMANDS_ROUTE = '/api/dsh-context/commands'

const PAGE_LIMIT = 400
const PAGE_LIMIT_MAX = 1_000

/** ~13ms of synchronous fold per chunk (the detail route's measured rate); yields keep the route off the event loop. */
const FOLD_YIELD_EVENTS = 1_000

/** A folded full command state is a few MB on a long session; two entries cover the tab and the modal reading at once. */
const STATE_CACHE_MAX = 2

interface CommandObservation {
  source?: unknown
  revision?: unknown
  cursor?: unknown
  events?: unknown
  [Symbol.dispose]?: unknown
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

interface CachedState {
  live: boolean
  /** The persistence service identity the stored log was read through (a swapped backend must not alias a stale fold). */
  persistence?: unknown
  revision?: string
  /** The last folded event seq (-1 for an empty log). */
  cursor: number
  state: TimelineState
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

/** The durable change token; absent on a live observation, a moving target that must never key the cache. */
function revisionOf(observation: CommandObservation): string | undefined {
  const revision = observation.revision
  return typeof revision === 'string' && revision !== '' ? revision : undefined
}

function cursorOf(observation: CommandObservation): number {
  const cursor = observation.cursor
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : -1
}

/** A cached entry covers this read when it is the same source (and, for a stored log, the same persistence identity and
 * durable revision) and its fold already reached no further than the observation's cut. */
function reusable(
  entry: CachedState | undefined,
  live: boolean,
  revision: string | undefined,
  cursor: number,
  persistence: unknown,
): boolean {
  if (entry === undefined || entry.live !== live || entry.cursor > cursor) return false
  return live || (entry.revision === revision && entry.persistence === persistence)
}

/** The newest `limit` records older than `beforeSeq`, oldest-first; `atStart` says this page reached the log's head. */
function pageOf(state: TimelineState, beforeSeq: number | undefined, limit: number): CommandPage {
  const older: CommandStateRecord[] = []
  for (const rec of state.commands) if (beforeSeq === undefined || rec.seq < beforeSeq) older.push(rec)
  older.sort((a, b) => a.seq - b.seq)
  const page = older.length > limit ? older.slice(older.length - limit) : older
  return {
    commands: page.map(serveCommand),
    atStart: older.length <= limit,
    total: state.commands.length,
  }
}

async function readPage(
  observation: CommandObservation,
  beforeSeq: number | undefined,
  limit: number,
  bounds: FoldBounds,
  cache: Map<string, CachedState>,
  sessionId: string,
  persistence: unknown,
): Promise<CommandPage | null> {
  const live = observation.source === 'live'
  const revision = live ? undefined : revisionOf(observation)
  const cursor = cursorOf(observation)
  const keyed = live || revision !== undefined
  const cached = cache.get(sessionId)
  const reuse = keyed && reusable(cached, live, revision, cursor, persistence)
  let state = reuse && cached !== undefined ? cached.state : createTimelineState()
  let cut = reuse && cached !== undefined ? cached.cursor : -1
  if (cut < cursor) {
    if (!Array.isArray(observation.events)) return null
    const fullBounds: FoldBounds = { ...bounds, maxCommands: Number.MAX_SAFE_INTEGER }
    let folded = 0
    for (let i = cut + 1; i < observation.events.length && i <= cursor; i++) {
      state = applyTimeline(state, observation.events[i] as never, fullBounds)
      cut = i
      if (++folded % FOLD_YIELD_EVENTS === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  if (keyed) {
    cache.delete(sessionId)
    cache.set(sessionId, { live, persistence, ...(revision !== undefined ? { revision } : {}), cursor: cut, state })
    for (const oldest of cache.keys()) {
      if (cache.size <= STATE_CACHE_MAX) break
      cache.delete(oldest)
    }
  }
  return pageOf(state, beforeSeq, limit)
}

/** Arm the paged command route: one folded state per session, extended by each later read and re-keyed when the
 * durable revision moves. Every face is re-proved; an absent one leaves the route unregistered. */
export function watchCommandPageChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate = makeColdReadGate(),
): void {
  const cache = new Map<string, CachedState>()
  ctx.inject(['connection', 'sessionQuery'], (c) => {
    const query = c.get('sessionQuery') as SessionQueryFace | undefined
    const observe = typeof query?.observeSession === 'function' ? query.observeSession.bind(query) : undefined
    if (observe === undefined) return
    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      let beforeSeq: unknown
      let limit: unknown
      try {
        const body: unknown = await request.json()
        if (body !== null && typeof body === 'object') {
          sessionId = (body as { sessionId?: unknown }).sessionId
          beforeSeq = (body as { beforeSeq?: unknown }).beforeSeq
          limit = (body as { limit?: unknown }).limit
        }
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      if (beforeSeq !== undefined && (typeof beforeSeq !== 'number' || !Number.isFinite(beforeSeq) || beforeSeq < 0)) {
        return failure('dsh-context/bad-request', 'beforeSeq must be a non-negative number')
      }
      const pageSize = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.floor(limit)))
        : PAGE_LIMIT
      try {
        const persistence: unknown = c.get('sessionPersistence')
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' }) as CommandObservation | null
          if (observation === null || typeof observation !== 'object') return null
          try {
            return await readPage(observation, beforeSeq, pageSize, bounds, cache, sessionId, persistence)
          } finally {
            const dispose = observation[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, COMMANDS_ROUTE, handler, 'dsh-context: command page route')
  })
}
