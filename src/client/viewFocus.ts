/** Chat → Context jump relay: the clicked reply's request seq is consumed once the target view's projection data is in. */

import { useEffect, useState } from 'react'
import { asRecord, type ClientCtx } from './services'
import { SIDEBAR_CONTEXT_KIND } from './sidebar'

const pendingFocus = new Map<string, number>()

const focusListeners = new Set<() => void>()

export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
  for (const listener of focusListeners) listener()
}

/** Every subscribed view wakes on each record and takes its OWN session's entry; the rest stay pending. */
export function subscribeContextFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

export function takeContextFocus(sessionId: string): number | null {
  const seq = pendingFocus.get(sessionId)
  if (seq === undefined) return null
  pendingFocus.delete(sessionId)
  return seq
}

/** Stats → Fleet member highlight relay: the roster chip's member id is the RESTING pick every subscribed view
 *  adopts (the tab, its own graph, the sidebar copy), so no consumer can eat another's pick. */

const memberFocus = new Map<string, string>()

const memberListeners = new Set<() => void>()

export function requestFleetMemberFocus(sessionId: string, memberId: string): void {
  memberFocus.set(sessionId, memberId)
  for (const listener of memberListeners) listener()
}

/** The latest pick for a session; absent = nothing picked yet. */
export function currentFleetMemberFocus(sessionId: string): string | null {
  return memberFocus.get(sessionId) ?? null
}

export function subscribeFleetMemberFocus(listener: () => void): () => void {
  memberListeners.add(listener)
  return () => { memberListeners.delete(listener) }
}

/** The resting member highlight a view renders: adopted on mount and on every later pick. */
export function useFleetMemberFocus(sessionId: string | undefined): string | null {
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    if (sessionId === undefined || sessionId === '') return undefined
    const sync = (): void => { setId(currentFleetMemberFocus(sessionId)) }
    sync()
    return subscribeFleetMemberFocus(sync)
  }, [sessionId])
  return id
}

/** `ctx.sidebarRight.openTab` (the column expands in the same step); any absence or hostility reports
 * false so the caller keeps its conversation-tab fallback. */
export function openContextSidebar(ctx: ClientCtx): boolean {
  try {
    const face = asRecord(ctx.get('sidebarRight'))
    if (face === null || typeof face.openTab !== 'function') return false
    ;(face.openTab as (kind: string) => void).call(face, SIDEBAR_CONTEXT_KIND)
    return true
  } catch {
    return false
  }
}

/** Click the tab's own `button[role="tab"]` chrome: the harness hands `openView` only to the ACTIVE view entry, so a nested action cannot
 * call it. */
export function activateViewTab(label: string): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const tab of tabs) {
    if (tab.textContent.trim() !== label) continue
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return true
  }
  return false
}
