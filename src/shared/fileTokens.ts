/** Per-file price: dsh prices a `file` block by its `fileHandleText`, never its bytes. The log carries
 * name, byte size, and digest prefix; the copy's read path is live-environment state, so this prices the pathless arm. */

import { estimateTextTokens } from './estimate'

const DIGEST_PREFIX_LENGTH = 'sha256:'.length
const DIGEST_SHOWN = 8

/** One file's handle price, or null when the log proves neither the name nor the byte size the handle is built from. */
export function estimateFileTokens(ref: { attachmentId: string; name?: string; bytes?: number }): number | null {
  if (ref.name === undefined || ref.bytes === undefined) return null
  const digest = ref.attachmentId.slice(DIGEST_PREFIX_LENGTH, DIGEST_PREFIX_LENGTH + DIGEST_SHOWN)
  const identity = `File ${JSON.stringify(ref.name)} (${ref.bytes} bytes, sha256:${digest})`
  const handle = `[${identity} was uploaded, but the current execution environment cannot access a`
    + ' readable path. Report that limitation if its contents are needed; do not claim to have read it.]'
  return estimateTextTokens(handle)
}
