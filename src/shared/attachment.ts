/** The durable attachment vocabulary both halves share: one parser normalizes the durable `type:` and the snapshot's `kind:` spellings,
 * so the host can re-prove WHICH attachment a session cites. */

export type AttachmentKind = 'image' | 'file'

/** One attachment block's proven facts; every optional field is re-proved, never borrowed. */
export interface AttachmentRef {
  kind: AttachmentKind
  attachmentId: string
  name?: string
  bytes?: number
  /** Images only: the media type verified when the raster was admitted. */
  mediaType?: string
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

/** Suffixes the preview column's image viewers claim — the harness's own image-body extensions. */
const EXTENSION_IMAGE: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
])

/** The leaf of a display name: both separator styles stripped, so a hostile log path never names a file outside the caller's directory. */
export function leafNameOf(name: string): string {
  return name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
}

/** The lower-case extension of a display name (no dot), following the harness's own `fileExtension`: a leading dot starts the suffix, so
 * `.env` is `env`. */
export function attachmentExtension(name: string): string {
  const base = leafNameOf(name)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Whether a display name's suffix is one the preview column's image viewers claim; an image with another suffix is named by its verified
 * media type instead. */
export function isImageName(name: string): boolean {
  return EXTENSION_IMAGE.has(attachmentExtension(name))
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function dimensionsOf(value: unknown): { width: number; height: number } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const dims = value as Record<string, unknown>
  const width = numOf(dims.width)
  const height = numOf(dims.height)
  return width !== undefined && height !== undefined ? { width, height } : undefined
}

/** One content block → its attachment reference, or null when it is none; re-proves every optional fact. */
export function attachmentOf(block: unknown): AttachmentRef | null {
  if (block === null || typeof block !== 'object') return null
  const b = block as { type?: unknown; kind?: unknown; attachment?: unknown }
  const spelling = typeof b.type === 'string' ? b.type : b.kind
  if (spelling !== 'image' && spelling !== 'file') return null
  if (b.attachment === null || typeof b.attachment !== 'object') return null
  const a = b.attachment as Record<string, unknown>
  if (typeof a.attachmentId !== 'string' || a.attachmentId === '') return null
  const name = typeof a.name === 'string' && a.name !== '' ? a.name : undefined
  const bytes = numOf(a.bytes)
  if (spelling === 'file') {
    return {
      kind: 'file',
      attachmentId: a.attachmentId,
      ...(name !== undefined ? { name } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
    }
  }
  const origDims = dimensionsOf(a.originalDimensions)
  const width = numOf(a.width)
  const height = numOf(a.height)
  const mediaType = typeof a.mediaType === 'string' && a.mediaType !== '' ? a.mediaType : undefined
  return {
    kind: 'image',
    attachmentId: a.attachmentId,
    ...(name !== undefined ? { name } : {}),
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(origDims !== undefined ? { originalDimensions: origDims } : {}),
  }
}

/** Every attachment of one message content, in the message's own order; a malformed block drops out instead of throwing. */
export function attachmentsIn(content: unknown): AttachmentRef[] {
  if (!Array.isArray(content)) return []
  const out: AttachmentRef[] = []
  for (const block of content) {
    const ref = attachmentOf(block)
    if (ref !== null) out.push(ref)
  }
  return out
}
