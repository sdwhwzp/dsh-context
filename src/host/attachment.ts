/** The attachment-preview route: the previewable host path for one attachment the session's own log cites — a stored file's named alias,
 * or a published hard link for a digest-named image. No bytes travel, and an id resolves only while the session's own log cites it. */

import { copyFile, link, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { attachmentOf, isImageName, leafNameOf } from '../shared/attachment'
import type { AttachmentRef } from '../shared/attachment'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { canReadAccountSession, type ConnectionHostFace, registerPostRoute } from './connection'

export const ATTACHMENT_ROUTE = '/api/dsh-context/attachment'

const IMAGE_MEDIA_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

interface AttachmentStoreFace {
  fileHostPath?(ref: unknown): string | undefined
  imageHostPath?(ref: unknown): string | undefined
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Depth cap: real citation sites nest ≤3 deep; the cap bounds hostile payloads. */
const WALK_MAX_DEPTH = 8

function attachmentIn(value: unknown, id: string, depth: number): AttachmentRef | null {
  if (depth > WALK_MAX_DEPTH) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = attachmentIn(item, id, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const ref = attachmentOf(value)
  if (ref !== null && ref.attachmentId === id) return ref
  for (const child of Object.values(value as Record<string, unknown>)) {
    const hit = attachmentIn(child, id, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/** The first logged block citing the attachment anywhere in the payload; a hostile payload drops out instead of throwing. */
export function referencedAttachmentOf(events: readonly unknown[], attachmentId: string): AttachmentRef | null {
  for (const entry of events) {
    try {
      const hit = attachmentIn(entry, attachmentId, 0)
      if (hit !== null) return hit
    } catch { /* a hostile payload names nothing */ }
  }
  return null
}

/** The name one image previews under: the preview viewer dispatches by suffix, so a display name counts only when its suffix is one a
 * viewer claims; the verified media type names the rest. */
export function imagePreviewNameOf(ref: AttachmentRef): string | null {
  const leaf = leafNameOf(ref.name ?? '')
  if (leaf !== '' && isImageName(leaf)) return leaf
  const extension = ref.mediaType !== undefined ? IMAGE_MEDIA_EXTENSION[ref.mediaType] : undefined
  return extension === undefined ? null : `attachment.${extension}`
}

/** The preview cache beside the store's `<home>/attachments/v1`; null when the object path is not that shape. */
function previewAliasDirOf(objectPath: string): string | null {
  const root = dirname(dirname(dirname(objectPath)))
  if (basename(root) !== 'v1' || basename(dirname(root)) !== 'attachments') return null
  return join(dirname(dirname(root)), 'cache', 'dsh-context', 'previews')
}

function filePathOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): string | null {
  if (typeof store?.fileHostPath !== 'function') return null
  try {
    const path = store.fileHostPath({ attachmentId: ref.attachmentId, name: ref.name ?? '', bytes: ref.bytes ?? 0 })
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    // A malformed reference (bad digest, unsanitized name) is no path, never a throw.
    return null
  }
}

/** Publish (or reuse) the named hard link an image previews through: an existing link is the same immutable object, so it is the answer;
 * a link-less host falls back to a copy, and any failure resolves null. */
async function imageAliasOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): Promise<string | null> {
  if (typeof store?.imageHostPath !== 'function') return null
  let objectPath: string | undefined
  try {
    objectPath = store.imageHostPath({
      attachmentId: ref.attachmentId,
      ...(ref.mediaType !== undefined ? { mediaType: ref.mediaType } : {}),
      ...(ref.bytes !== undefined ? { bytes: ref.bytes } : {}),
      ...(ref.width !== undefined ? { width: ref.width } : {}),
      ...(ref.height !== undefined ? { height: ref.height } : {}),
      ...(ref.name !== undefined ? { name: ref.name } : {}),
    })
  } catch {
    return null
  }
  if (typeof objectPath !== 'string' || objectPath === '') return null
  const name = imagePreviewNameOf(ref)
  if (name === null) return null
  const directory = previewAliasDirOf(objectPath)
  if (directory === null) return null
  const alias = join(directory, basename(dirname(objectPath)), basename(objectPath), name)
  try {
    await mkdir(dirname(alias), { recursive: true })
    try {
      await link(objectPath, alias)
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) await copyFile(objectPath, alias)
    }
    return alias
  } catch {
    return null
  }
}

async function previewPathOf(store: AttachmentStoreFace | undefined, ref: AttachmentRef): Promise<string | null> {
  return ref.kind === 'file' ? filePathOf(store, ref) : await imageAliasOf(store, ref)
}

/** Serve whenever `connection` is composed; `sessionQuery` and the attachment store are re-read per request, so a late-arriving service
 * still arms. */
export function watchAttachmentChannel(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (request: Request, principal?: unknown): Promise<Response> => {
      let sessionId: unknown
      let attachmentId: unknown
      try {
        const body = asRecord(await request.json())
        sessionId = body?.sessionId
        attachmentId = body?.attachmentId
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      if (typeof attachmentId !== 'string' || attachmentId === '') {
        return failure('dsh-context/bad-request', 'missing attachmentId')
      }
      try {
        if (!await canReadAccountSession(c, principal, sessionId, request.signal)) return failure('gateway/forbidden', 'session access denied')
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return reply({ ok: true, value: null })
        const store = ctx.get('attachments') as AttachmentStoreFace | undefined
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          try {
            const events = (observation as { events?: unknown } | null)?.events
            if (!Array.isArray(events)) return null
            const ref = referencedAttachmentOf(events, attachmentId)
            if (ref === null) return null
            const path = await previewPathOf(store, ref)
            return path === null ? null : { path }
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, ATTACHMENT_ROUTE, handler, 'dsh-context: attachment route')
  })
}
