import type { CommandRecord, CommandPage } from '../shared/types'
import { COMMANDS_ROUTE } from './apiRoutes'
import { pageCommandOf } from './commandRecords'
import { postRoute } from './route'
import { asRecord } from './services'

function finiteOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function commandPageOf(value: unknown): CommandPage | null {
  const data = asRecord(value)
  if (data === null || typeof data.atStart !== 'boolean' || !Array.isArray(data.commands)) return null
  const total = finiteOf(data.total)
  if (total === undefined || total < 0) return null
  const commands: CommandRecord[] = []
  for (const entry of data.commands) {
    const rec = pageCommandOf(entry)
    if (rec !== null) commands.push(rec)
  }
  return { commands, atStart: data.atStart, total }
}

export type CommandPageFetcher = (beforeSeq: number) => Promise<CommandPage | null>

export function makeCommandPager(
  sessionId: string,
  limit?: number,
): CommandPageFetcher | undefined {
  if (sessionId === '') return undefined
  return beforeSeq => postRoute(
    COMMANDS_ROUTE,
    { sessionId, beforeSeq, ...(limit === undefined ? {} : { limit }) },
    commandPageOf,
    { label: 'command page' },
  )
}
