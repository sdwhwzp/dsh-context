import type { Context } from '@deepseek-ai/cordis'
import type { BackfillHandle } from './backfill'
import type { CachedSnapshotFace, SessionQueryFace, SnapshotProjectionsFace } from './faces'
import { corpusRevisionOf, revisionOf, type HostSession } from './overviewCorpus'
import { identityKey, type OverviewCache } from './overviewCache'
import { withCost, type CostSource } from './cost'
import { billedGeneratedOf } from './overviewDecode'
import { asRecord } from './record'
import { isAccountRequest, readableAccountSessions } from './connection'
import { accountRevision, failure, mountPostRoute, readBody, reply, routeFailure } from './postRoute'

export const SNAPSHOT_ROUTE = '/api/dsh-context/snapshot'

export const SNAPSHOT_IDS_MAX = 256

const SNAPSHOT_KEYS = new Set<string>(['contextTimeline', 'contextActivity'])

function compactCountsOf(value: unknown): Record<string, number> | undefined {
  const counts = asRecord(value)
  if (counts === null) return undefined
  const compact: Record<string, number> = {}
  for (const field of ['turns', 'steps'] as const) {
    const count = counts[field]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) compact[field] = count
  }
  return Object.keys(compact).length > 0 ? compact : undefined
}

const COMPACT_TIMING_FIELDS = [
  'wallMs', 'ttftMs', 'genMs', 'calls', 'toolsMs', 'toolCalls',
  'reasoningMs', 'reasoningBlocks', 'textMs', 'textBlocks', 'toolArgMs', 'toolArgBlocks',
  'toolBusyMs', 'idleMs', 'speedTokens', 'speedMs',
] as const

function compactTimingOf(value: unknown): Record<string, unknown> | undefined {
  const timing = asRecord(value)
  if (timing === null) return undefined
  const compact: Record<string, unknown> = {}
  for (const field of COMPACT_TIMING_FIELDS) {
    const figure = timing[field]
    if (typeof figure === 'number' && Number.isFinite(figure)) compact[field] = figure
  }
  if (Object.keys(compact).length === 0) return undefined
  compact.tools = {}
  return compact
}

function compactTimelineOf(value: unknown): Record<string, unknown> | undefined {
  const view = asRecord(value)
  if (view === null) return undefined
  const compact: Record<string, unknown> = { ok: view.ok === undefined ? true : view.ok }
  const current = asRecord(view.current)
  if (current !== null) compact.current = current
  if (typeof view.contextWindow === 'number' && Number.isFinite(view.contextWindow)) compact.contextWindow = view.contextWindow
  const counts = compactCountsOf(view.counts)
  if (counts !== undefined) compact.counts = counts
  const cost = asRecord(view.cost)
  if (cost !== null) compact.cost = cost
  const timing = compactTimingOf(view.timing)
  if (timing !== undefined) compact.timing = timing
  if (typeof view.lastUser === 'string' && view.lastUser !== '') compact.lastUser = view.lastUser
  for (const field of ['generatedReasoning', 'generatedAnswerTokens', 'generatedCallTokens'] as const) {
    const figure = view[field]
    if (typeof figure === 'number' && Number.isFinite(figure)) compact[field] = figure
  }
  const billedGenerated = billedGeneratedOf(view.billedGenerated)
  if (billedGenerated !== undefined) compact.billedGenerated = billedGenerated
  const costRead = asRecord(view.costRead)
  if (costRead !== null) {
    const usd = typeof costRead.usd === 'number' && Number.isFinite(costRead.usd) ? costRead.usd : null
    compact.costRead = { usd, ready: costRead.ready === true }
  }
  return compact
}


function wantedIdsOf(body: Record<string, unknown>): Set<string> | null | undefined {
  const ids = body.ids
  if (!Array.isArray(ids)) return undefined
  const wanted = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id !== '') wanted.add(id)
    if (wanted.size > SNAPSHOT_IDS_MAX) return null
  }
  return wanted.size > 0 ? wanted : undefined
}

export function watchSnapshotRoute(
  ctx: Context,
  backfill?: BackfillHandle,
  ownCache?: OverviewCache,
  cost?: CostSource,
): void {
  let servedRequests: { revision: string; keys: Set<string> } | null = null
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'],
    path: SNAPSHOT_ROUTE,
    label: 'dsh-context: snapshot route',
    handler: (c) => {
      const query = c.get('sessionQuery') as SessionQueryFace
      const cache = c.get('sessionProjectionCache') as CachedSnapshotFace
      const projections = c.get('sessionProjections') as SnapshotProjectionsFace
      const sessions = c.get('sessions') as { get(id: string): unknown }
      const listSessions = query.listSessions.bind(query)
      const snapshotOf = projections.snapshot.bind(projections)
      const cachedOf = cache.cachedSnapshot.bind(cache)
      const getSession = sessions.get.bind(sessions)

      return async (request: Request, principal): Promise<Response> => {
        const read = await readBody(request)
        if (!read.ok) return read.response
        const body = asRecord(read.body)
        const wanted = body === null ? undefined : wantedIdsOf(body)
        if (wanted === null) {
          return failure('dsh-context/bad-request', `at most ${String(SNAPSHOT_IDS_MAX)} ids per request`)
        }
        const requestedRevision = typeof body?.revision === 'string' && body.revision !== '' ? body.revision : undefined
        const servedKey = wanted === undefined ? 'all' : JSON.stringify([...wanted].sort())
        const scoped = isAccountRequest(c, principal)
        try {
          const records = await listSessions(request.signal)
          if (!Array.isArray(records)) return reply({ ok: true, value: {} })
          const headers = new Map<string, Record<string, unknown>>()
          for (const record of records) {
            const header = asRecord(asRecord(record)?.header)
            const id = header?.id
            if (header !== null && typeof id === 'string' && id !== '' && (wanted === undefined || wanted.has(id))) {
              headers.set(id, header)
            }
          }
          const candidates = await readableAccountSessions(c, principal, [...headers.keys()], request.signal)
          const liveSessions = new Map<string, unknown>()
          const coldIds = new Set<string>()
          for (const id of candidates) {
            try {
              const session = getSession(id)
              if (session === undefined) coldIds.add(id)
              else liveSessions.set(id, session)
            } catch {
              continue
            }
          }
          let materialized = new Map<string, HostSession>()
          let stale = new Set<string>()
          let sourceKey = ''
          if (ownCache !== undefined && coldIds.size > 0) {
            try {
              const loaded = await ownCache.load(coldIds)
              materialized = loaded.sessions
              stale = loaded.rebuild
              const sources = [...loaded.identities].map(([id, identity]) => `${id}\u0000${identityKey(identity)}`)
              sources.sort()
              sourceKey = revisionOf([...sources, ...[...stale].sort().map(id => `R${id}`)])
            } catch {}
          }
          let localRevision = ''
          if (!scoped) {
            const baseRevision = corpusRevisionOf(records, getSession, backfill?.version() ?? 0)
            const pricingKey = cost === undefined ? '' : cost.ready() ? `ready${cost.version?.() ?? 0}` : 'cold'
            localRevision = revisionOf([baseRevision, sourceKey, pricingKey])
            if (requestedRevision === localRevision
              && servedRequests !== null && servedRequests.revision === localRevision && servedRequests.keys.has(servedKey)) {
              return reply({ ok: true, value: {}, revision: localRevision, unchanged: true })
            }
          }
          const readable = scoped
            ? new Set(await readableAccountSessions(c, principal, candidates, request.signal))
            : undefined
          const rows = new Map<string, Record<string, unknown>>()
          for (const [id, header] of headers) {
            if (readable !== undefined && !readable.has(id)) continue
            if (!coldIds.has(id) && !liveSessions.has(id)) continue
            let served: Record<string, unknown> | null = null
            try {
              const session = liveSessions.get(id)
              if (session !== undefined) {
                served = asRecord(snapshotOf(session, SNAPSHOT_KEYS)?.values)
              } else {
                const materialization = materialized.get(id)?.materialization
                if (materialization !== undefined) {
                  const timeline = asRecord(materialization.values.contextTimeline)
                  served = {
                    ...materialization.values,
                    ...(timeline === null ? {} : { contextTimeline: withCost(cost, timeline) }),
                  }
                } else if (!stale.has(id)) {
                  served = asRecord(cachedOf(header, SNAPSHOT_KEYS)?.values)
                }
              }
            } catch {
              continue
            }
            if (served === null) continue
            const picked: Record<string, unknown> = {}
            const compact = compactTimelineOf(served.contextTimeline)
            if (compact !== undefined) picked.contextTimeline = compact
            if (served.contextActivity !== undefined) picked.contextActivity = served.contextActivity
            if (Object.keys(picked).length > 0) rows.set(id, picked)
          }
          request.signal.throwIfAborted()
          const values = Object.fromEntries(rows)
          const revision = readable === undefined ? localRevision : accountRevision([servedKey, [...readable].sort(), values])
          if (scoped && requestedRevision === revision) return reply({ ok: true, value: {}, revision, unchanged: true })
          if (!scoped) servedRequests = { revision, keys: new Set([servedKey]) }
          return reply({ ok: true, value: values, revision })
        } catch (err) {
          return routeFailure(err)
        }
      }
    },
  })
}
