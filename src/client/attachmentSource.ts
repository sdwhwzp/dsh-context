/** On-click attachment plumbing: nothing is fetched while a row renders; one click resolves the named host path. */

import { previewAddressOf } from './fileActivity'
import type { AttachmentRef } from '../shared/attachment'
import { ATTACHMENT_ROUTE } from './apiRoutes'
import { asRecord, openResourceVia } from './services'
import type { AttachmentLocator, AttachmentOpener, ClientCtx } from './services'

/** Cache ceiling: cards are clicked one at a time, so a small FIFO holds a session's working set. */
const CACHE_MAX = 32

const paths = new Map<string, string>()

/** Drop every cached location (tests and account-page teardown). */
export function clearAttachmentPaths(): void {
  paths.clear()
}

export function pathOfValue(value: unknown): string | null {
  const data = asRecord(value)
  return data !== null && typeof data.path === 'string' && data.path !== '' ? data.path : null
}

/** The session-authorized locator; a failed resolution resolves null and is never cached, so a retry re-reads. */
export function makeAttachmentLocator(sessionId: string | undefined): AttachmentLocator | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return async (attachment: AttachmentRef) => {
    const key = JSON.stringify([sessionId, attachment.attachmentId])
    const cached = paths.get(key)
    if (cached !== undefined) return cached
    try {
      const response = await fetch(ATTACHMENT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, attachmentId: attachment.attachmentId }),
      })
      if (!response.ok) return null
      const body = asRecord(await response.json())
      if (body === null || body.ok !== true) return null
      const path = pathOfValue(body.value)
      if (path === null) return null
      if (paths.size >= CACHE_MAX) {
        const oldest = paths.keys().next().value
        /* v8 ignore next 1 -- the cap fires only on a non-empty cache, so the key always exists. */
        if (oldest !== undefined) paths.delete(oldest)
      }
      paths.set(key, path)
      return path
    } catch {
      return null
    }
  }
}

/** Open through the File Activity card's own rungs: the route-named host path, then `dsh-resource://file/…`. */
export function makeAttachmentOpener(
  ctx: ClientCtx,
  sessionId: string | undefined,
  workspace: string | undefined,
): AttachmentOpener | undefined {
  const locate = makeAttachmentLocator(sessionId)
  const openPreview = openResourceVia(ctx)
  if (locate === undefined || openPreview === undefined) return undefined
  return async (attachment: AttachmentRef) => {
    const path = await locate(attachment)
    if (path === null) return false
    // The address layer only refuses directories; the preview column picks the viewer by path suffix.
    const address = previewAddressOf(path, 'text', false, sessionId, workspace)
    return address !== undefined && openPreview(address)
  }
}
