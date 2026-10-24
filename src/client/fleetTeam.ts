/** The Agent Teams plane: the experimental `agentTeam` projection rides the LEAD session's wire values.
 * Absent stays null (the panel hides); malformed entries drop alone. */

import { asRecord } from './services'
import type { AgentForest, AgentNode } from './agentTree'

export interface FleetTeamMember {
  id: string
  name: string
  role: 'lead' | 'teammate'
  /** Durable lifecycle; the lead's row is always active. */
  phase: 'provisioning' | 'active' | 'failed'
  error?: string
}

export interface FleetTeamTask {
  id: string
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Owner membership NAME (the wire view carries names, not ids — join by name). */
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  /** Server-computed readiness: pending with every blocker completed. Readiness never auto-starts the owner. */
  ready: boolean
  warnings: string[]
}

export interface FleetTeam {
  /** Lead first (the harness synthesizes its row), then roster order. */
  members: FleetTeamMember[]
  tasks: FleetTeamTask[]
  /** The first rejected durable record; the board then sits at its last valid state. */
  failure?: string
}

function memberOf(value: unknown): FleetTeamMember | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (typeof rec.id !== 'string' || rec.id === '') return null
  if (typeof rec.name !== 'string' || rec.name === '') return null
  if (rec.role !== 'lead' && rec.role !== 'teammate') return null
  if (rec.phase !== 'provisioning' && rec.phase !== 'active' && rec.phase !== 'failed') return null
  return {
    id: rec.id,
    name: rec.name,
    role: rec.role,
    phase: rec.phase,
    ...(typeof rec.error === 'string' && rec.error !== '' ? { error: rec.error } : {}),
  }
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v !== '')
}

function taskOf(value: unknown): FleetTeamTask | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (typeof rec.id !== 'string' || rec.id === '') return null
  if (typeof rec.subject !== 'string' || rec.subject === '') return null
  if (rec.status !== 'pending' && rec.status !== 'in_progress' && rec.status !== 'completed') return null
  return {
    id: rec.id,
    subject: rec.subject,
    description: typeof rec.description === 'string' ? rec.description : '',
    status: rec.status,
    ...(typeof rec.ownerName === 'string' && rec.ownerName !== '' ? { ownerName: rec.ownerName } : {}),
    blockedBy: stringsOf(rec.blockedBy),
    writeScopes: stringsOf(rec.writeScopes),
    ready: rec.ready === true,
    warnings: stringsOf(rec.writeScopeWarnings),
  }
}

/** A record without a sound member list degrades whole to null. */
export function teamOf(value: unknown): FleetTeam | null {
  const rec = asRecord(value)
  if (rec === null || !Array.isArray(rec.members)) return null
  const members: FleetTeamMember[] = []
  for (const entry of rec.members) {
    try {
      const member = memberOf(entry)
      if (member !== null) members.push(member)
    } catch { /* one hostile entry leaves its siblings readable */ }
  }
  const tasks: FleetTeamTask[] = []
  if (Array.isArray(rec.tasks)) {
    for (const entry of rec.tasks) {
      try {
        const task = taskOf(entry)
        if (task !== null) tasks.push(task)
      } catch { /* one hostile entry leaves its siblings readable */ }
    }
  }
  return {
    members,
    tasks,
    ...(typeof rec.failure === 'string' && rec.failure !== '' ? { failure: rec.failure } : {}),
  }
}

export function teamMemberOf(team: FleetTeam | null, sessionId: string): FleetTeamMember | null {
  if (team === null) return null
  for (const member of team.members) {
    if (member.id === sessionId) return member
  }
  return null
}

/** Teammates only: the lead keeps the session title, the current card is the self card, outsiders keep their prompt. */
export function teammateNameOf(team: FleetTeam | null, node: AgentNode): string | undefined {
  if (node.isCurrent) return undefined
  const member = teamMemberOf(team, node.id)
  return member !== null && member.role === 'teammate' ? member.name : undefined
}

/** A member's id off their roster NAME — the task board's ownership join key. */
export function memberIdByName(team: FleetTeam | null, name: string | undefined): string | undefined {
  if (team === null || name === undefined) return undefined
  for (const member of team.members) {
    if (member.name === name) return member.id
  }
  return undefined
}

export function tasksOfOwner(team: FleetTeam | null, ownerName: string | undefined): FleetTeamTask[] {
  if (team === null || ownerName === undefined) return []
  return team.tasks.filter(task => task.ownerName === ownerName)
}

/** Family nodes outside the roster — plain subagents, ancestors, siblings; the current session never counts. */
export function familyOthersOf(forest: AgentForest | null, team: FleetTeam | null): AgentNode[] {
  if (forest === null) return []
  return forest.nodes.filter(n => !n.isCurrent && teamMemberOf(team, n.id) === null)
}
