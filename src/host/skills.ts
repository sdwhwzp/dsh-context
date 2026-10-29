import type { ColdReadGate } from './coldRead'
/** The skill-catalog route: metadata behind the Insights page's skill card (description, origin bucket, on-disk path), joined by name
 * onto the activity ledger's tallies. The harness's `skills/list` Remote strips the origin, so the plugin reads the host-side registry
 * through the session — web compositions mount discovery on agent presets, so the global registry alone lists nothing. */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillInfo } from '../shared/types'
import { canReadAccountSession, type ConnectionHostFace, registerPostRoute } from './connection'

export const SKILLS_ROUTE = '/api/dsh-context/skills'

const MAX_SKILLS = 500

interface SkillRegistryLike {
  list(options: { cwd?: string; scope?: unknown }): Promise<unknown>
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function disposeOf(resource: unknown): Promise<void> {
  if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) return
  try {
    const asyncDispose = (resource as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose]
    if (typeof asyncDispose === 'function') {
      await (asyncDispose as () => Promise<void>).call(resource)
      return
    }
    const syncDispose = (resource as { [Symbol.dispose]?: unknown })[Symbol.dispose]
    if (typeof syncDispose === 'function') (syncDispose as () => void).call(resource)
  } catch {
  }
}

function skillInfoOf(value: unknown): SkillInfo | null {
  const record = asRecord(value)
  if (record === null || typeof record.name !== 'string' || record.name === '') return null
  return {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : '',
    ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
    ...(typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {}),
  }
}

/** The session's catalog view: its workspace and recorded preset off a sessionQuery observation; an unknown session leaves the request's
 * cwd as the only selector. */
async function sessionViewOf(
  ctx: Context, sessionId: string | undefined, signal: AbortSignal, coldReads: ColdReadGate,
): Promise<{ cwd?: string; agentPreset?: string } | null> {
  if (sessionId === undefined) return {}
  return await coldReads.admit(async () => {
    const query = asRecord(ctx.get('sessionQuery'))
    if (typeof query?.observeSession !== 'function') return {}
    let observation: unknown
    try {
      observation = await (query.observeSession as (id: string) => Promise<unknown>).call(query, sessionId)
    } catch {
      return {}
    }
    try {
      const obs = asRecord(observation)
      const values = asRecord(asRecord(obs?.projections)?.values)
      let cwd = stringOf(values?.workingDirectory) ?? stringOf(asRecord(obs?.header)?.cwd)
      const agents = asRecord(ctx.get('agents'))
      const directory = asRecord(ctx.get('workingDirectory'))
      const live: unknown = typeof agents?.get === 'function' ? (agents.get as (id: string) => unknown).call(agents, sessionId) : undefined
      if (live !== undefined && typeof directory?.ensure === 'function') {
        const ensure = directory.ensure as (agent: unknown, signal: AbortSignal) => Promise<unknown>
        cwd = stringOf(await ensure.call(directory, live, signal)) ?? cwd
      }
      const agentPreset = stringOf(values?.agentPreset)
      return {
        ...(cwd === undefined ? {} : { cwd }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      }
    } finally {
      await disposeOf(observation)
    }
  }) ?? null
}

async function resolveRegistry(
  ctx: Context,
  sessionId: string | undefined,
  agentPreset: string | undefined,
): Promise<{ registry: SkillRegistryLike; scope: unknown; lease: unknown } | null> {
  const presets = asRecord(ctx.get('agentPresets'))
  let live: unknown
  if (sessionId !== undefined) {
    const agents = asRecord(ctx.get('agents'))
    if (typeof agents?.get === 'function') {
      try {
        live = (agents.get as (id: string) => unknown).call(agents, sessionId)
      } catch {
        live = undefined
      }
    }
  }
  if (live !== undefined && live !== null && typeof presets?.serviceFor === 'function') {
    const scoped = asRecord((presets.serviceFor as (agent: unknown, name: string) => unknown).call(presets, live, 'skills'))
    if (scoped !== null && typeof scoped.list === 'function') {
      return { registry: scoped as unknown as SkillRegistryLike, scope: live, lease: undefined }
    }
  }
  const registry = asRecord(ctx.get('skills'))
  if (registry === null || typeof registry.list !== 'function') return null
  let scope: unknown
  let lease: unknown
  if (typeof presets?.acquireScope === 'function') {
    try {
      lease = await (presets.acquireScope as (id?: string) => Promise<unknown>).call(presets, agentPreset)
      scope = asRecord(lease)?.key
    } catch {
      lease = undefined
    }
  }
  return { registry: registry as unknown as SkillRegistryLike, scope, lease }
}

/** Serve whenever `connection` composes; every harness face is re-proved per request, so a missing subsystem answers null. */
export function watchSkillCatalog(ctx: Context, coldReads: ColdReadGate): void {
  ctx.inject(['connection'], (c) => {

    const handler = async (request: Request, principal?: unknown): Promise<Response> => {
      let value: { skills: SkillInfo[] } | null = null
      let lease: unknown
      try {
        const body = asRecord(await request.json())
        const sessionId = stringOf(body?.sessionId)
        if (!await canReadAccountSession(c, principal, sessionId, request.signal)) {
          return Response.json({ ok: false, error: { code: 'gateway/forbidden', message: 'session access denied' } }, { headers: { 'cache-control': 'no-store' } })
        }
        const view = await sessionViewOf(ctx, sessionId, request.signal, coldReads)
        if (view === null) return Response.json({ ok: true, value: null }, { headers: { 'cache-control': 'no-store' } })
        const accountScoped = principal !== undefined || c.get('requestPrincipal') !== undefined || c.get('principalAccess') !== undefined
        const cwd = view.cwd ?? (accountScoped ? undefined : stringOf(body?.cwd))
        const resolved = await resolveRegistry(ctx, sessionId, view.agentPreset)
        if (resolved !== null) {
          lease = resolved.lease
          const listed: unknown = await resolved.registry.list({
            ...(cwd === undefined ? {} : { cwd }),
            ...(resolved.scope === undefined ? {} : { scope: resolved.scope }),
          })
          const rows = Array.isArray(listed) ? listed : []
          const skills: SkillInfo[] = []
          for (const row of rows) {
            const info = skillInfoOf(row)
            if (info !== null) skills.push(info)
            if (skills.length >= MAX_SKILLS) break
          }
          value = { skills }
        }
      } catch {
      } finally {
        await disposeOf(lease)
      }
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, SKILLS_ROUTE, handler, 'dsh-context: skills route')
  })
}
