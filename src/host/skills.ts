import { asRecord } from './record'
import { stringOf } from '../shared/decode'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillInfo } from '../shared/types'
import { AccountAccessUnavailableError, canReadAccountSession, isAccountRequest } from './connection'
import { makeColdReadGate, type ColdReadGate } from './coldRead'
import { failure, mountPostRoute, observeOf, reply, routeFailure } from './postRoute'

export const SKILLS_ROUTE = '/api/dsh-context/skills'

const MAX_SKILLS = 500

interface SkillRegistryLike {
  list(options: { cwd?: string; scope?: unknown }): Promise<unknown>
}

export interface AgentsFace {
  get?(id: string): unknown
}

export interface WorkingDirectoryFace {
  ensure?(agent: unknown, signal: AbortSignal): Promise<unknown>
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

function liveAgentOf(ctx: Context, sessionId: string | undefined): unknown {
  if (sessionId === undefined) return undefined
  const agents = ctx.get('agents') as AgentsFace | undefined
  try {
    return typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  } catch {
    return undefined
  }
}

async function sessionViewOf(
  ctx: Context, sessionId: string | undefined, live: unknown, signal: AbortSignal, coldReads: ColdReadGate,
): Promise<{ cwd?: string; agentPreset?: string } | null> {
  if (sessionId === undefined) return {}
  let liveCwd: string | undefined
  const directory = ctx.get('workingDirectory') as WorkingDirectoryFace | undefined
  if (live != null && typeof directory?.ensure === 'function') {
    liveCwd = stringOf(await directory.ensure(live, signal))
  }
  const observe = observeOf(ctx)
  const fallback = liveCwd === undefined ? {} : { cwd: liveCwd }
  if (observe === undefined) return fallback
  return await coldReads.admit(async () => {
    let observation: unknown
    try {
      observation = await observe(sessionId, { projectionMode: 'all', signal })
      const obs = asRecord(observation)
      const header = asRecord(obs?.header)
      const values = asRecord(asRecord(obs?.projections)?.values)
      const cwd = liveCwd ?? stringOf(values?.workingDirectory) ?? stringOf(header?.cwd)
      const agentPreset = stringOf(values?.agentPreset) ?? stringOf(header?.agentPreset)
      return {
        ...(cwd === undefined ? {} : { cwd }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      }
    } catch {
      signal.throwIfAborted()
      return fallback
    } finally {
      await disposeOf(observation)
    }
  }) ?? (liveCwd === undefined ? null : fallback)
}

async function resolveRegistry(
  ctx: Context,
  live: unknown,
  agentPreset: string | undefined,
): Promise<{ registry: SkillRegistryLike; scope: unknown; lease: unknown } | null> {
  const presets = asRecord(ctx.get('agentPresets'))
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

export function watchSkillCatalog(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: SKILLS_ROUTE,
    label: 'dsh-context: skills route',
    handler: c => async (request: Request, principal): Promise<Response> => {
      let value: { skills: SkillInfo[] } | null = null
      let lease: unknown
      try {
        const body = asRecord(await request.json())
        const sessionId = stringOf(body?.sessionId)
        if (!await canReadAccountSession(c, principal, sessionId, request.signal)) {
          return failure('gateway/forbidden', 'session access denied')
        }
        const live = liveAgentOf(c, sessionId)
        const view = await sessionViewOf(c, sessionId, live, request.signal, coldReads) ?? {}
        const accountScoped = isAccountRequest(c, principal)
        const cwd = view.cwd ?? (accountScoped ? undefined : stringOf(body?.cwd))
        if (accountScoped && cwd === undefined) return reply({ ok: true, value: null })
        const resolved = await resolveRegistry(c, live, view.agentPreset)
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
      } catch (error) {
        if (error instanceof AccountAccessUnavailableError) return routeFailure(error)
      } finally {
        await disposeOf(lease)
      }
      return reply({ ok: true, value })
    },
  })
}
