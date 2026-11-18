import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { seatOf } from './seats'
import { asRecord } from './wire'

type SnapshotSeat = (selector: (snapshot: unknown) => unknown) => unknown

const NO_SNAPSHOT: SnapshotSeat = selector => selector(null)

const CURRENT_SESSION_KEY = 'dsh.sessions.current'

export interface CurrentSession {
  id: string
  cwd?: string
}

function persistedCurrentId(): string | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined
    const raw = localStorage.getItem(CURRENT_SESSION_KEY)
    const id = raw === null ? undefined : asRecord(JSON.parse(raw))?.sessionId
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

function rowOf(byId: Record<string, unknown> | null, id: string): Record<string, unknown> | null {
  try {
    return byId !== null && Object.hasOwn(byId, id) ? asRecord(byId[id]) : null
  } catch {
    return null
  }
}

function retainedIdOf(byId: Record<string, unknown> | null): string | undefined {
  if (byId === null) return undefined
  for (const id in byId) {
    try {
      const row = rowOf(byId, id)
      const count = asRecord(row?.retainInfo ?? row?.retainedBy)?.mainView
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) return id
    } catch {
      continue
    }
  }
  return undefined
}

function currentKeyOf(snapshot: unknown): string {
  const state = asRecord(snapshot)
  const byId = asRecord(state?.byId)
  const current = state?.current
  const selected = typeof current === 'string' && current !== '' ? current : retainedIdOf(byId)
  const id = selected ?? persistedCurrentId()
  if (id === undefined) return ''
  const row = rowOf(byId, id)
  if (selected === undefined && row === null && byId !== null && state?.phase === 'ready' && Array.isArray(state.ids)) return ''
  try {
    const cwd = row?.cwd
    if (typeof cwd === 'string' && cwd !== '') return `${id}\u0000${cwd}`
  } catch {
    return id
  }
  return id
}

export function currentSessionOf(props: { useSessions?: unknown }): CurrentSession | null {
  const read = seatOf(props.useSessions, NO_SNAPSHOT)
  let key: unknown = null
  try {
    key = read(currentKeyOf)
  } catch {}
  if (typeof key === 'string') {
    if (key === '') return null
    const split = key.indexOf('\u0000')
    return split < 0 ? { id: key } : { id: key.slice(0, split), cwd: key.slice(split + 1) }
  }
  const id = persistedCurrentId()
  return id === undefined ? null : { id }
}

export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

export const UNGROUPED_KEY = '__ungrouped__'
