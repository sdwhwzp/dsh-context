import { previewAddressOf } from './fileActivity'
import type { AttachmentRef } from '../shared/attachment'
import { ATTACHMENT_ROUTE } from './apiRoutes'
import { postRoute, RouteError } from './route'
import { asRecord, openResourceVia } from './services'
import type { AttachmentLocator, AttachmentOpener, ClientCtx } from './services'
import { clientScopeOf } from './timelineSource'

let pending = new AbortController()

export function clearAttachmentPaths(): void {
  pending.abort()
  pending = new AbortController()
}

export function pathOfValue(value: unknown): string | null {
  const data = asRecord(value)
  return data !== null && typeof data.path === 'string' && data.path !== '' ? data.path : null
}

export function makeAttachmentLocator(sessionId: string | undefined): AttachmentLocator | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return async (attachment: AttachmentRef) => {
    const scope = clientScopeOf()
    if (scope === null) return null
    const signal = AbortSignal.any([scope, pending.signal])
    try {
      const path = await postRoute(ATTACHMENT_ROUTE, { sessionId, attachmentId: attachment.attachmentId }, pathOfValue, { signal })
      return signal.aborted ? null : path
    } catch (error) {
      if (!signal.aborted && error instanceof RouteError && (error.status === 401 || error.status === 403)) clearAttachmentPaths()
      return null
    }
  }
}

export function makeAttachmentOpener(
  ctx: ClientCtx,
  sessionId: string | undefined,
  workspace: string | undefined,
): AttachmentOpener | undefined {
  const locate = makeAttachmentLocator(sessionId)
  const openPreview = openResourceVia(ctx)
  if (locate === undefined || openPreview === undefined) return undefined
  return async (attachment: AttachmentRef) => {
    const scope = clientScopeOf()
    const signal = pending.signal
    const path = await locate(attachment)
    if (path === null || scope === null || scope.aborted || signal.aborted) return false
    const address = previewAddressOf(path, 'text', false, sessionId, workspace)
    return address !== undefined && openPreview(address)
  }
}
