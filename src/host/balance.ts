/** The DeepSeek open-platform balance route: the API key never rides to the browser, so the host reads `GET /user/balance` from the
 * platform ROOT and serves only redacted figures. Any missing fact answers a typed `null`, and identical in-flight reads share one
 * outbound fetch. */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { type ConnectionHostFace, registerPostRoute } from './connection'

export const BALANCE_ROUTE = '/api/dsh-context/balance'

/** The API-key provider route key: the `deepseek-account` route holds no key and never serves the balance. */
const DEEPSEEK_PROVIDER = 'deepseek-official'

/** Stock entry ids of the platform's own settings rows, including the two web rows carrying the same credential. */
const DEEPSEEK_SETTINGS_IDS = ['llm-deepseek', 'web-deepseek-api', 'web-search-deepseek']

const PUBLIC_BASE_URL = 'https://api.deepseek.com'

const FETCH_TIMEOUT_MS = 10_000

interface SettingsHostFace {
  describe?(options?: { redactSecrets?: boolean }): unknown
}

/** The provider directory names the DeepSeek row, so a renamed entry still answers. */
interface LlmHostFace {
  listConfigurableProviders?(): unknown
}

interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

interface DeepSeekFacts { baseUrl: string; apiKey: string }

interface DeepSeekRow {
  apiKeyEnv: string
  baseURL?: string
}

/** Candidate settings ids in fold order: the row the provider directory names, then the stock ids. */
function deepseekSettingsIds(ctx: Context): string[] {
  const ids: string[] = []
  const llm = ctx.get('llm') as LlmHostFace | undefined
  if (typeof llm?.listConfigurableProviders === 'function') {
    try {
      const entries = llm.listConfigurableProviders()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          try {
            const record = asRecord(entry)
            if (record === null || record.provider !== DEEPSEEK_PROVIDER) continue
            const id = record.settingsNs
            if (typeof id === 'string' && id !== '' && !ids.includes(id)) ids.push(id)
          } catch {
            continue
          }
        }
      }
    } catch {
      // The directory is optional: the stock ids below still answer.
    }
  }
  for (const id of DEEPSEEK_SETTINGS_IDS) if (!ids.includes(id)) ids.push(id)
  return ids
}

/** Fold the DeepSeek platform rows from the redacted Config-form `describe()` projection: the credential ref and endpoint override live
 * at the section root, and a hostile row drops whole while valid siblings serve. */
function deepseekRowsOf(ctx: Context): DeepSeekRow[] {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  if (typeof settings?.describe !== 'function') return []
  let rows: unknown
  try {
    // Read redacted: a row's literal key is a secret this fold has no use for.
    rows = settings.describe({ redactSecrets: true })
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    try {
      const record = asRecord(row)
      if (record === null) continue
      const id = record.ns
      const value = asRecord(record.value)
      if (typeof id !== 'string' || value === null || byId.has(id)) continue
      byId.set(id, value)
    } catch {
      continue
    }
  }
  const deepseekRows: DeepSeekRow[] = []
  for (const id of deepseekSettingsIds(ctx)) {
    const value = byId.get(id)
    if (value === undefined) continue
    const apiKeyEnv = value.apiKeyEnv
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') continue
    const baseURL = value.baseURL
    deepseekRows.push({
      apiKeyEnv,
      baseURL: typeof baseURL === 'string' && baseURL !== '' ? baseURL : undefined,
    })
  }
  return deepseekRows
}

/** Only the ORIGIN counts: the account route sits at the API root while row endpoints carry paths. */
function platformRootOf(baseURL: string | undefined): string {
  if (baseURL === undefined) return PUBLIC_BASE_URL
  try {
    const url = new URL(baseURL)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return PUBLIC_BASE_URL
    return url.origin
  } catch {
    return PUBLIC_BASE_URL
  }
}

/** The first DeepSeek row whose credential resolves serves; `null` when any fact is missing. */
async function resolveFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  const tried = new Set<string>()
  for (const row of deepseekRowsOf(ctx)) {
    if (tried.has(row.apiKeyEnv)) continue
    tried.add(row.apiKeyEnv)
    let hit: { value?: unknown } | undefined
    try {
      hit = await resolve(row.apiKeyEnv)
    } catch {
      continue
    }
    const apiKey = typeof hit?.value === 'string' ? hit.value : ''
    if (apiKey === '') continue
    return { baseUrl: platformRootOf(row.baseURL), apiKey }
  }
  return null
}

/** The total is the two re-proved parts summed, so the viewer's arithmetic is the authority; an entry failing the shape drops whole, and
 * a payload with no valid entry is no balance at all. */
export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // A hostile entry may throw on property access; it drops whole.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const granted = amountOf(entry.granted_balance)
      const toppedUp = amountOf(entry.topped_up_balance)
      if (typeof currency !== 'string' || currency === ''
        || granted === null || toppedUp === null) continue
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.is_available === true, balances }
    : null
}

type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let inFlight: Promise<PlatformBalance | null> | null = null

export function resetBalance(): void {
  inFlight = null
}

/** One platform read shared by identical reads already in flight; nothing is remembered, since the balance moves with every billed
 * request. Every failure path — transport, timeout, non-ok status, malformed payload — resolves `null`. */
async function readBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    let value: PlatformBalance | null = null
    try {
      const response = await fetcher(facts.baseUrl + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) value = balanceOfPayload(await response.json())
    } catch {
      // Any failure serves null — the capsule stays hidden.
    }
    return value
  })()
  const settled = inFlight
  try {
    return await settled
  } finally {
    // Clear the shared slot so the next read fetches fresh figures.
    inFlight = null
  }
}

/** The registration rides the injected fiber, so unloading withdraws it. */
export function watchBalanceChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {

    const handler = async (_request: Request, principal?: unknown): Promise<Response> => {
      if ((principal !== undefined || c.get('requestPrincipal') !== undefined || c.get('principalAccess') !== undefined)
        && asRecord(principal)?.role !== 'admin') {
        return Response.json({ ok: true, value: null }, { headers: { 'cache-control': 'no-store' } })
      }
      const facts = await resolveFacts(ctx)
      const value = facts !== null ? await readBalance(facts) : null
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BALANCE_ROUTE, handler, 'dsh-context: balance route')
  })
}
