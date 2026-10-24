/**
 * The `contextHeaders` projection unit: request-header epoch METADATA behind the timeline's envelope figures — the
 * epoch CONTENT (system prompt, tool schemas) would ride every `session.list` row and push frame whole. `stateVersion`
 * stays 1: a bump invalidates every cached row and orphans an idle session's key until it goes live, so the view
 * normalizes both record generations to the metadata-only wire form and the client fetches one epoch on demand.
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WiredProjection } from './projection'
import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
import { estimateToolSchema } from './pricing'
import { estimateSystemTokens } from '../shared/estimate'

const HEADERS_MAX = 50

/** v1 rows carried the producer description and raw schema; later folds append metadata-only. */
interface StoredHeaderTool {
  name: string
  tokens: number
  description?: string
  plugin?: string
  schema?: unknown
}

/** v1 rows carried `system`; later folds carry `systemTokens`. */
interface StoredHeaderRecord {
  seq: number
  time: number
  system?: string
  systemTokens?: number
  tools: StoredHeaderTool[]
}

export interface HeadersState {
  headers: StoredHeaderRecord[]
}

/** The superset of both record generations, so a cached content-bearing v1 row still seeds a fold. */
const storedToolSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  description: z.string().optional(),
  plugin: z.string().optional(),
  schema: z.unknown().optional(),
}).strict()

const storedEpochSchema = z.object({
  seq: z.number(),
  time: z.number(),
  system: z.string().optional(),
  systemTokens: z.number().int().nonnegative().optional(),
  tools: z.array(storedToolSchema),
}).strict()

const contextHeadersStateSchema = z.object({
  headers: z.array(storedEpochSchema),
}).strict() as unknown as z.ZodType<HeadersState>

const headerToolWireSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  plugin: z.string().optional(),
}).strict()

export const contextHeadersSchema = z.object({
  headers: z.array(z.object({
    seq: z.number(),
    time: z.number(),
    // Absent when the epoch logged no system prompt; sizes the section pre-fetch.
    systemTokens: z.number().int().nonnegative().optional(),
    tools: z.array(headerToolWireSchema),
  }).strict()),
}).strict() as unknown as z.ZodType<ContextHeaders>

function recordOf(event: SessionEvent): StoredHeaderRecord | null {
  if (event.type !== 'request/header') return null
  // This unit has no try/catch, so an impossible shape must degrade to "not an epoch" instead of throwing out of the registry's drive loop.
  const rawHeader = (event.data as { header?: unknown } | undefined)?.header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  // A supported epoch header never carries a system prompt, so epochs fold metadata-only; the stored `system` field exists for cached v1
  // rows.
  const header = rawHeader as { tools?: unknown[] }
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: StoredHeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): StoredHeaderTool => {
      // A null or primitive entry degrades to an unnamed, JSON-priced tool instead of throwing.
      const tool = (t !== null && typeof t === 'object' ? t : {}) as { name?: unknown; plugin?: unknown }
      const entry: StoredHeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
      }
      // Kept verbatim so the view-time resolver never overrides an attribution the producer wrote; no supported-baseline path writes one.
      if (typeof tool.plugin === 'string' && tool.plugin !== '') {
        entry.plugin = tool.plugin
      }
      return entry
    }),
  }
  return record
}

/** @param resolve - best-effort tool-to-plugin attribution; fills a missing `plugin` at view time. */
export function createContextHeadersDefinition(
  resolve?: (name: string) => string | undefined,
): WiredProjection<'contextHeaders', HeadersState> {
  // The view strips legacy v1 content here; the system text is priced once per read.
  const view = (state: HeadersState): ContextHeaders => ({
    headers: state.headers.map((h): HeaderRecord => {
      const record: HeaderRecord = {
        seq: h.seq,
        time: h.time,
        tools: h.tools.map((t): HeaderTool => {
          const entry: HeaderTool = { name: t.name, tokens: t.tokens }
          const plugin = t.plugin ?? (resolve !== undefined ? resolve(t.name) : undefined)
          if (plugin !== undefined) entry.plugin = plugin
          return entry
        }),
      }
      const systemTokens = h.systemTokens
        ?? (typeof h.system === 'string' && h.system !== '' ? estimateSystemTokens(h.system) : undefined)
      if (systemTokens !== undefined) record.systemTokens = systemTokens
      return record
    }),
  })
  const definition: WiredProjection<'contextHeaders', HeadersState> = {
    key: 'contextHeaders',
    stateSchema: contextHeadersStateSchema,
    wire: { viewSchema: contextHeadersSchema, view },
    init: (): HeadersState => ({ headers: [] }),
    apply: (state: HeadersState, event: SessionEvent): HeadersState => {
      const record = recordOf(event)
      if (record === null) return state
      // The agent loop suppresses unchanged headers; this guards a same-epoch replay.
      const last = state.headers.at(-1)
      if (last !== undefined && last.seq === record.seq) return state
      const headers = [...state.headers, record]
      return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
    },
    stateVersion: 1,
  }
  return definition
}
