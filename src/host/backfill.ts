import { asRecord } from './record'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { BackfillCoverage, BackfillUnreadableSession } from '../shared/types'
import type { Config } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { makeFoldJournal } from './foldJournal'
import { createFoldPool, type FoldPool } from './foldWorker'
import { identityKey, type OverviewCache } from './overviewCache'
import { headerFactsOf, materializedSessionOf, revisionOf } from './overviewCorpus'
import { isAccountRequest, isActiveAccount } from './connection'
import { failure, mountPostRoute, reply } from './postRoute'

export const BACKFILL_ROUTE = '/api/dsh-context/backfill'

export interface FoldedSessions {
  version: number
  ids: string[] | null
  workerIds: string[] | null
}

type BackfillRefusal =
  | { kind: 'failed' }
  | { kind: 'unsupported' }
  | { kind: 'unreadable'; reason: string }

export interface BackfillSessionStatus {
  running: boolean
  refusal: BackfillRefusal | undefined
}

export interface BackfillHandle {
  (): void
  request(): void
  coverage(): BackfillCoverage
  version(): number
  foldedSince(marker: number): FoldedSessions
  statusOf?(id: string): BackfillSessionStatus | undefined
}

interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

interface ProjectionCacheLike {
  cachedSnapshot(meta: SessionHeader, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

interface SlicedFoldFaces {
  restore(
    checkpoint: unknown, events: readonly SessionEvent[], baseSeq: number, header: SessionHeader, inheritedEventCount: unknown,
  ): unknown
  hydrate(session: unknown, checkpoint: unknown, events: readonly SessionEvent[], baseSeq: number): unknown
  prepare(id: string, options: { seed: readonly SessionEvent[]; meta: unknown; inheritedEventCount: unknown; eventState: string }): unknown
  write(session: unknown): Promise<unknown>
}

interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
  stat?(id: string): Promise<unknown>
}

/** The pacing floor for BOTH granularities: each cold read is a full log decode, and the pass must never exceed ~50% duty. */
const MIN_REST_MS = 25

const SLICE_EVENTS = 2_000

const MIN_SLICE_EVENTS = 128

const BLOCK_BUDGET_MS = 150

const WORKER_FOLD_MIN_EVENTS = 30_000

const ROUND_WORK_BUDGET_MS = 8_000
const ROUND_PAUSE_MS = 2_000

const RETRY_BASE_MS = 1_000

const RETRY_MAX_MS = 15_000

const RETRY_ATTEMPTS_MAX = 10

export interface BackfillPacing {
  now: () => number
  sleep: (ms: number) => Promise<void>
  minRestMs: number
  workBudgetMs: number
  roundPauseMs: number
  sliceBudgetMs?: number
}

export interface BackfillOptions {
  ownCache?: OverviewCache
  config?: Config
  pool?: FoldPool
  autoStart?: boolean
  retryBaseMs?: number
  onStart?: () => void
  onChange?: () => void
}

export type { FoldPool }

const DEFAULT_PACING: BackfillPacing = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  minRestMs: MIN_REST_MS,
  workBudgetMs: ROUND_WORK_BUDGET_MS,
  roundPauseMs: ROUND_PAUSE_MS,
}

const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

const UNREADABLE_HOST_LOG = 'SessionPersistenceCorruption'

const UNREADABLE_REASON_MAX = 180

export const UNREADABLE_DETAIL_MAX = 16

function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

const PROBE_KEYS = ['contextActivity', 'contextTimeline']

interface StatCapability {
  reportsEventCount?: boolean
}

async function durableEventCount(
  persistence: PersistenceLike,
  id: string,
  capability: StatCapability,
): Promise<number | undefined> {
  if (capability.reportsEventCount === false) return undefined
  if (typeof persistence.stat !== 'function') return undefined
  try {
    const snapshot = asRecord(await persistence.stat(id))
    const eventCount = snapshot?.eventCount
    if (typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0) {
      capability.reportsEventCount = true
      return eventCount
    }
    if (snapshot !== null && !('eventCount' in snapshot)) capability.reportsEventCount = false
    return undefined
  } catch {
    return undefined
  }
}

async function servesRows(
  persistence: PersistenceLike,
  cache: ProjectionCacheLike,
  header: SessionHeader,
  capability: StatCapability,
  presenceIsFresh: boolean,
): Promise<boolean> {
  let block: Record<string, unknown> | null
  try {
    block = asRecord(cache.cachedSnapshot(header, PROBE_KEYS))
  } catch {
    return false
  }
  const values = asRecord(block?.values)
  if (values === null || values.contextActivity === undefined || values.contextTimeline === undefined) return false
  const asOfSeq = block?.asOfSeq
  if (typeof asOfSeq !== 'number' || !Number.isSafeInteger(asOfSeq)) return false
  const eventCount = await durableEventCount(persistence, header.id, capability)
  if (eventCount === undefined) return presenceIsFresh
  return asOfSeq + 1 === eventCount || asOfSeq === eventCount
}

async function readColdLog(
  persistence: PersistenceLike,
  id: string,
  signal: AbortSignal,
): Promise<{ header: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }> {
  const handle = await persistence.open(id, 'read', { signal })
  let events: readonly SessionEvent[]
  try {
    signal.throwIfAborted()
    const raw: unknown = await handle.read(0, undefined, { signal })
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result : []
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {}
    throw error
  }
  await handle.close()
  signal.throwIfAborted()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events],
  }
}

function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

interface SliceOutcome {
  outcome: 'done' | 'live'
  workMs: number
  snapshot?: unknown
  write?: () => Promise<unknown>
}

export function nextSliceSize(size: number, costMs: number, budgetMs: number): number {
  if (costMs <= 0) return Math.min(SLICE_EVENTS, size * 2)
  if (costMs > budgetMs) return Math.max(MIN_SLICE_EVENTS, Math.floor(size * budgetMs / costMs))
  if (costMs * 4 < budgetMs) return Math.min(SLICE_EVENTS, size * 2)
  return size
}

async function coldSnapshotSliced(
  faces: SlicedFoldFaces,
  sessions: Record<string, unknown> | null,
  log: { header: SessionHeader; inheritedEventCount: unknown; events: readonly SessionEvent[] },
  signal: AbortSignal,
  rest: (costMs: number) => Promise<void>,
  now: () => number,
  budgetMs: number,
): Promise<SliceOutcome> {
  const { header, inheritedEventCount, events } = log
  let rows: unknown = {}
  let workMs = 0
  let end = 0
  let size = SLICE_EVENTS
  for (;;) {
    end = Math.min(events.length, end + size)
    const last = end >= events.length
    const started = now()
    const restored = asRecord(faces.restore(rows, last ? events : events.slice(0, end), 0, header, inheritedEventCount))
    rows = restored?.checkpoint ?? {}
    const sliceCost = now() - started
    workMs += sliceCost
    size = nextSliceSize(size, sliceCost, budgetMs)
    if (last) break
    await rest(sliceCost)
    signal.throwIfAborted()
  }
  let prepared: unknown
  try {
    prepared = faces.prepare(header.id, {
      seed: events,
      meta: structuredClone(header),
      inheritedEventCount,
      eventState: 'shared-frozen',
    })
  } catch (error: unknown) {
    if (isLive(sessions, header.id)) return { outcome: 'live', workMs }
    throw error
  }
  const snapshot = faces.hydrate(prepared, rows, events, 0)
  return { outcome: 'done', workMs, snapshot, write: () => faces.write(prepared) }
}

function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

function isUnreadableHostLog(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNREADABLE_HOST_LOG)
  } catch {
    return false
  }
}

function unreadableReasonOf(error: unknown): string {
  const reason = messageOf(error)
  return reason.length > UNREADABLE_REASON_MAX ? `${reason.slice(0, UNREADABLE_REASON_MAX)}…` : reason
}

function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

function emptyCoverage(): BackfillCoverage {
  return {
    complete: false,
    remaining: 0,
    failed: 0,
    running: false,
    total: 0,
    covered: 0,
    unsupported: 0,
    unreadable: 0,
  }
}

export function watchActivityBackfill(
  ctx: Context,
  coldReads: ColdReadGate = makeColdReadGate(),
  pacing: BackfillPacing = DEFAULT_PACING,
  options: BackfillOptions = {},
): BackfillHandle {
  let requested = false
  const lifetime = new AbortController()
  let launch: (() => void) | null = null
  let version = 0
  let foldedVersion = 0
  const journal = makeFoldJournal()
  let pool: FoldPool | null = null
  let cancelStartup: (() => void) | null = null
  let cancelDisposed: (() => void) | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0
  const workerFor = (): FoldPool => {
    pool ??= options.pool ?? createFoldPool()
    return pool
  }
  let coverage = emptyCoverage()
  const refusals = new Map<string, BackfillRefusal>()
  let foldingId: string | undefined
  const startIfIdle = (): void => {
    if (lifetime.signal.aborted || coverage.running || !requested || launch === null) return
    requested = false
    coverage.running = true
    launch()
  }
  const clearRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }
  ctx.effect(() => () => {
    lifetime.abort()
    clearRetry()
    pool?.dispose()
    pool = null
  }, 'dsh-context: backfill lifetime')
  const requestPass = (): void => {
    if (lifetime.signal.aborted) return
    clearRetry()
    try { options.onStart?.() } catch {}
    requested = true
    startIfIdle()
  }
  const requestFreshPass = (): void => {
    retryAttempt = 0
    requestPass()
  }
  const queueRetry = (): void => {
    if (options.autoStart !== true || retryTimer !== null || retryAttempt >= RETRY_ATTEMPTS_MAX) return
    const base = options.retryBaseMs ?? RETRY_BASE_MS
    const delay = Math.min(RETRY_MAX_MS, base * 2 ** Math.min(retryAttempt, 10))
    retryAttempt++
    retryTimer = setTimeout(() => {
      retryTimer = null
      requestPass()
    }, delay)
    ;(retryTimer as { unref?: () => void }).unref?.()
  }
  const noteFolded = (id: string, viaWorker = false): void => {
    retryAttempt = 0
    foldedVersion++
    journal.note(id, viaWorker)
    try { options.onChange?.() } catch {}
  }
  const routeFiber = mountPostRoute({
    ctx,
    deps: ['connection'],
    path: BACKFILL_ROUTE,
    label: 'dsh-context: backfill route',
    handler: c => async (request, principal) => {
      if (isAccountRequest(c, principal)) {
        if (!await isActiveAccount(c, principal, request.signal)) {
          return failure('gateway/forbidden', 'session access denied')
        }
        if (!coverage.running && !requested) requestFreshPass()
        return reply({ ok: true })
      }
      requestFreshPass()
      return reply({ ok: true, coverage: { ...coverage } })
    },
  })

  const runnerFiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
    const injected = raw as unknown as {
      sessionQuery?: unknown
      sessionProjectionCache?: unknown
      sessionPersistence?: unknown
      sessions?: unknown
    }
    const query = asRecord(injected.sessionQuery)
    const cache = asRecord(injected.sessionProjectionCache)
    const persistence = asRecord(injected.sessionPersistence)
    if (query === null || typeof query.listSessions !== 'function') return
    if (cache === null
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function') return
    if (persistence === null || typeof persistence.open !== 'function') return
    const sessions = asRecord(injected.sessions)
    const signatureOf = (records: readonly unknown[]): string => {
      const parts: string[] = []
      for (const record of records) {
        const header = headerOf(record)
        if (header === null) continue
        const live = isLive(sessions, header.id) ? 'L' : 'C'
        parts.push(`${header.id}\u0000${String(header.createdAt)}\u0000${header.cwd ?? ''}\u0000${live}`)
      }
      parts.sort()
      return revisionOf(parts)
    }

    const registry = asRecord((ctx as unknown as Record<string, unknown>).sessionProjections)
    const sliceFaces: SlicedFoldFaces | null = registry !== null
      && typeof registry.restore === 'function'
      && typeof registry.hydrate === 'function'
      && sessions !== null
      && typeof sessions.prepare === 'function'
      && typeof cache.write === 'function'
      ? {
        restore: (registry.restore as SlicedFoldFaces['restore']).bind(registry),
        hydrate: (registry.hydrate as SlicedFoldFaces['hydrate']).bind(registry),
        prepare: (sessions.prepare as SlicedFoldFaces['prepare']).bind(sessions),
        write: (cache.write as SlicedFoldFaces['write']).bind(cache),
      }
      : null

    const abort = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, abort.signal])
    let inFlight: Promise<void> | undefined
    let lastSignature: string | null = null
    const run = async (): Promise<void> => {
      const previousCoverage = JSON.stringify(coverage)
      const pass = emptyCoverage()
      const unreadableSessions: BackfillUnreadableSession[] = []
      let listed = false
      let folded = 0
      let paused = false
      let sourceChanged = false
      let cacheLimited = false
      let roundWork = 0
      const sleep = async (ms: number): Promise<void> => {
        signal.throwIfAborted()
        let onAbort!: () => void
        const aborted = new Promise<void>((resolve) => { onAbort = resolve })
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          await Promise.race([pacing.sleep(ms), aborted])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
      const rest = async (costMs: number): Promise<void> => {
        signal.throwIfAborted()
        roundWork += costMs
        if (roundWork >= pacing.workBudgetMs) {
          roundWork = 0
          ctx.logger.info(`dsh-context: projection backfill pausing after ${Math.round(pacing.workBudgetMs / 1000)}s of fold work; resuming in ${Math.round(pacing.roundPauseMs / 1000)}s`)
          await sleep(pacing.roundPauseMs)
          return
        }
        await sleep(Math.max(pacing.minRestMs, costMs))
      }
      const remainingOf = (): number => Math.max(0, pass.total - pass.covered - pass.failed - pass.unsupported - pass.unreadable)
      const publishCoverage = (complete: boolean): void => {
        coverage.complete = complete
        coverage.remaining = remainingOf()
        coverage.failed = pass.failed
        coverage.total = pass.total
        coverage.covered = pass.covered
        coverage.unsupported = pass.unsupported
        coverage.unreadable = pass.unreadable
        if (unreadableSessions.length > 0) coverage.unreadableSessions = [...unreadableSessions]
        else delete coverage.unreadableSessions
      }
      const statCapability: StatCapability = {}
      try {
        const listedRecords = await (query as unknown as SessionQueryLike).listSessions(signal)
        signal.throwIfAborted()
        if (!Array.isArray(listedRecords)) return
        listed = true
        const retained = new Set<string>()
        for (const record of listedRecords) {
          const header = headerOf(record)
          if (header !== null && typeof header.cwd === 'string') retained.add(header.id)
        }
        pass.total = retained.size
        for (const id of refusals.keys()) if (!retained.has(id)) refusals.delete(id)
        if (!coverage.complete) publishCoverage(false)
        const ownCache = options.ownCache
        const workerConfig = options.config
        const statCapable = typeof (persistence as unknown as PersistenceLike).stat === 'function'
        const foldResources = (): { pool: FoldPool; cache: OverviewCache; config: Config } | null =>
          ownCache !== undefined && workerConfig !== undefined && statCapable
            ? { pool: workerFor(), cache: ownCache, config: workerConfig }
            : null
        const warmIds = new Set<string>()
        const rebuildIds = new Set<string>()
        let signature = signatureOf(listedRecords)
        if (ownCache !== undefined && pass.total > 0) {
          const candidates = new Set<string>()
          for (const record of listedRecords) {
            const header = headerOf(record)
            if (header !== null && typeof header.cwd === 'string' && !isLive(sessions, header.id)) candidates.add(header.id)
          }
          const ownWarm = await ownCache.probe(candidates)
          signal.throwIfAborted()
          for (const id of ownWarm.warm) warmIds.add(id)
          for (const id of ownWarm.rebuild) rebuildIds.add(id)
          const sources = [...candidates].map(id => `${id}\u0000${identityKey(ownWarm.identities.get(id))}`)
          sources.sort()
          signature = revisionOf([signature, ...sources])
        }
        if (coverage.complete && coverage.unreadable === 0 && rebuildIds.size === 0 && signature === lastSignature) {
          pass.covered = coverage.covered
          pass.unsupported = coverage.unsupported
          return
        }
        lastSignature = signature
        for (const record of listedRecords) {
          signal.throwIfAborted()
          publishCoverage(false)
          const header = headerOf(record)
          if (header === null || typeof header.cwd !== 'string' || !retained.delete(header.id)) continue
          if (isLive(sessions, header.id)) {
            refusals.delete(header.id)
            pass.covered++
            continue
          }
          const warm = refusals.get(header.id)?.kind !== 'unreadable' && (
            warmIds.has(header.id) || (!rebuildIds.has(header.id) && await servesRows(
              persistence as unknown as PersistenceLike,
              cache as unknown as ProjectionCacheLike,
              header,
              statCapability,
              ownCache === undefined,
            ))
          )
          signal.throwIfAborted()
          if (warm) {
            refusals.delete(header.id)
            pass.covered++
            continue
          }
          const started = pacing.now()
          let slicedWorkMs = 0
          let workerWallMs = 0
          let viaWorker = false
          try {
            foldingId = header.id
            const admitted = await coldReads.admit(async () => {
              signal.throwIfAborted()
              const resources = foldResources()
              const host = { stat: (persistence as unknown as PersistenceLike).stat?.bind(persistence) }
              const captured = resources === null ? null : await resources.cache.capture([header.id], host)
              signal.throwIfAborted()
              const identity = captured?.get(header.id) ?? null
              const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, signal)
              signal.throwIfAborted()
              const writeBack = async (write?: () => Promise<unknown>): Promise<void> => {
                if (write === undefined) return
                try {
                  await write()
                } catch (error: unknown) {
                  signal.throwIfAborted()
                  ctx.logger.warn(`dsh-context: projection backfill write-back for "${header.id}" failed (cache stays stale): ${messageOf(error)}`)
                }
              }
              const sourceIsCurrent = async (): Promise<boolean> => {
                signal.throwIfAborted()
                if (resources === null) return true
                const validated = await resources.cache.capture([header.id], host)
                signal.throwIfAborted()
                return identityKey(identity) === identityKey(validated.get(header.id) ?? null)
                  && !isLive(sessions, header.id)
              }
              const persist = async (
                snapshot: unknown,
                write?: () => Promise<unknown>,
              ): Promise<'done' | 'stale' | 'unaccepted'> => {
                if (!await sourceIsCurrent()) return 'stale'
                signal.throwIfAborted()
                await writeBack(write)
                signal.throwIfAborted()
                if (resources === null) return 'done'
                const facts = headerFactsOf(log.header as unknown as Record<string, unknown>)
                if (facts !== null) {
                  const session = materializedSessionOf(facts.id, facts, `C${identityKey(identity)}`, snapshot as { values?: unknown; asOfSeq?: unknown })
                  if (session.materialization !== undefined
                    && !await resources.cache.save([{ session, identity }])) return 'unaccepted'
                }
                return 'done'
              }
              if (log.events.length > WORKER_FOLD_MIN_EVENTS && resources !== null) {
                const facts = headerFactsOf(header as unknown as Record<string, unknown>)
                /* v8 ignore next 1 */
                if (facts !== null) {
                  try {
                    const folded1 = await resources.pool.fold(resources.config, log.events)
                    signal.throwIfAborted()
                    const persisted = await persist({
                      asOfSeq: log.events.at(-1)?.seq ?? -1,
                      values: {
                        contextTimeline: folded1.timeline,
                        contextActivity: folded1.activity,
                        ...(folded1.title === undefined ? {} : { title: folded1.title }),
                        sessionListMetadata: {
                          blank: folded1.blank,
                          ...(folded1.lastPromptAt > 0 ? { lastPromptAt: folded1.lastPromptAt } : {}),
                        },
                      },
                    })
                    if (persisted === 'done') {
                      workerWallMs = pacing.now() - started
                      viaWorker = true
                      return persisted
                    }
                    if (persisted === 'stale') return persisted
                  } catch (error) {
                    signal.throwIfAborted()
                    ctx.logger.warn(`dsh-context: worker fold for "${header.id}" failed; folding on the host thread instead (${messageOf(error)})`)
                  }
                }
              }
              signal.throwIfAborted()
              if (sliceFaces !== null && log.events.length > SLICE_EVENTS) {
                const budgetMs = pacing.sliceBudgetMs ?? BLOCK_BUDGET_MS
                const sliced = await coldSnapshotSliced(sliceFaces, sessions, log, signal, rest, pacing.now, budgetMs)
                slicedWorkMs = sliced.workMs
                return sliced.outcome === 'done' ? await persist(sliced.snapshot, sliced.write) : sliced.outcome
              }
              if (!await sourceIsCurrent()) return 'stale' as const
              signal.throwIfAborted()
              const snapshot = (cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
              return await persist(snapshot)
            }, { priority: 'background' })
            signal.throwIfAborted()
            if (admitted === undefined) {
              paused = true
              break
            }
            if (admitted === 'stale') {
              paused = true
              sourceChanged = true
              break
            }
            if (admitted === 'unaccepted') {
              paused = true
              cacheLimited = true
              break
            }
            refusals.delete(header.id)
            if (admitted === 'done') {
              folded++
              noteFolded(header.id, viaWorker)
            }
            if (workerWallMs > 0) slicedWorkMs = workerWallMs
            pass.covered++
          } catch (error: unknown) {
            signal.throwIfAborted()
            if (isUnsupportedFormat(error)) {
              refusals.set(header.id, { kind: 'unsupported' })
              pass.unsupported++
              ctx.logger.debug(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
            } else if (isUnreadableHostLog(error)) {
              pass.unreadable++
              const reason = unreadableReasonOf(error)
              refusals.set(header.id, { kind: 'unreadable', reason })
              if (unreadableSessions.length < UNREADABLE_DETAIL_MAX) unreadableSessions.push({ id: header.id, reason })
              ctx.logger.warn(`dsh-context: projection backfill cannot read "${header.id}" (host refused the log: ${reason})`)
            } else {
              refusals.set(header.id, { kind: 'failed' })
              pass.failed++
              ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
            }
          } finally {
            foldingId = undefined
          }
          await rest(Math.max(0, pacing.now() - started - slicedWorkMs))
        }
      } finally {
        if (listed && !signal.aborted) {
          const complete = !paused && remainingOf() === 0 && pass.failed === 0
          publishCoverage(complete)
          const changed = JSON.stringify(coverage) !== previousCoverage
          if (folded > 0 || changed) version++
          if (complete) {
            retryAttempt = 0
            clearRetry()
          } else {
            queueRetry()
          }
          if (changed) {
            try { options.onChange?.() } catch {}
          }
        }
      }
      signal.throwIfAborted()
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
      if (cacheLimited) {
        ctx.logger.info('dsh-context: projection backfill paused because the overview cache could not accept a record; another pass is required')
      } else if (paused && !sourceChanged) {
        ctx.logger.info(`dsh-context: projection backfill stopped early under heap pressure (${options.autoStart === true ? 'remaining sessions retry in the background' : 'remaining sessions refold on their next live activity'})`)
      }
      if (sourceChanged) {
        ctx.logger.info('dsh-context: projection backfill stopped after a durable source changed during a fold')
      }
      if (pass.unsupported > 0) {
        ctx.logger.info(`dsh-context: projection backfill skipped ${pass.unsupported} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
      if (pass.unreadable > 0) {
        ctx.logger.info(`dsh-context: projection backfill left ${pass.unreadable} session(s) unreadable by the host; the next pass retries them`)
      }
    }
    launch = () => {
      inFlight = run().catch((error: unknown) => {
        if (signal.aborted) return
        ctx.logger.warn(`dsh-context: projection backfill stopped early (${messageOf(error)})`)
        queueRetry()
      }).finally(() => {
        inFlight = undefined
        if (signal.aborted) return
        coverage.running = false
        startIfIdle()
      })
    }
    startIfIdle()
    return () => {
      launch = null
      coverage = emptyCoverage()
      refusals.clear()
      foldingId = undefined
      version++
      clearRetry()
      retryAttempt = 0
      abort.abort()
      return inFlight
    }
  })

  if (options.autoStart === true) ctx.effect(() => {
    cancelDisposed = ctx.on('session/disposed', requestFreshPass)
    const ready = asRecord(ctx.get('appReady'))
    if (ready !== null && typeof ready.onReady === 'function') {
      try {
        const disposer = (ready.onReady as (listener: () => void) => unknown)(requestFreshPass)
        if (typeof disposer === 'function') cancelStartup = disposer as () => void
      } catch {
        requestFreshPass()
      }
    } else {
      requestFreshPass()
    }
    return () => {
      cancelDisposed?.()
      cancelDisposed = null
      cancelStartup?.()
      cancelStartup = null
    }
  }, 'dsh-context: startup backfill')

  function disposeAll(): void {
    lifetime.abort()
    clearRetry()
    cancelDisposed?.()
    cancelDisposed = null
    cancelStartup?.()
    cancelStartup = null
    for (const fiber of [routeFiber, runnerFiber]) {
      const target = fiber as { dispose?: () => unknown } | undefined
      void target?.dispose?.()
    }
  }
  return Object.assign(disposeAll, {
    request: requestFreshPass,
    coverage: (): BackfillCoverage => ({ ...coverage }),
    statusOf: (id: string): BackfillSessionStatus | undefined => {
      const refusal = refusals.get(id)
      const running = foldingId === id
      return running || refusal !== undefined ? { running, refusal } : undefined
    },
    version: (): number => version,
    foldedSince: (marker: number): FoldedSessions => {
      if (marker === foldedVersion) return { version: foldedVersion, ids: [], workerIds: [] }
      const drained = journal.drain()
      return { version: foldedVersion, ids: drained.ids, workerIds: drained.workerIds }
    },
  })
}
