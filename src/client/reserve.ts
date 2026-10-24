/** dsh-compaction-basic's default window fraction for pressure (`DEFAULT_THRESHOLD_RATIO`). */
export const COMPACT_THRESHOLD_RATIO = 0.8

/** dsh-compaction-basic's default pressure headroom beyond the output reservation — the inline `?? 65_536` in that package's
 * `resolveConfig`. */
export const COMPACT_HEADROOM_TOKENS = 65_536

/** Where the reserve starts and what it is made of, in WINDOW tokens. */
export interface ContextReserve {
  /** Window tokens at which automatic pressure compaction triggers. */
  threshold: number
  /** The compaction-headroom mask, always the mirrored policy value. */
  headroom: number
  /** The routed request's output reservation at the window's end. */
  output: number
}

/** Undefined when no positive window is known or the harness refuses to configure pressure compaction for the route.
 *  `maxOutputTokens` is untrusted wire input: anything but a positive finite cap reserves nothing (envelope cap, else zero). */
export function reserveGeometry(
  window: number | undefined,
  maxOutputTokens: number | undefined,
): ContextReserve | undefined {
  if (window === undefined || !Number.isFinite(window) || window <= 0) return undefined
  const output = Math.min(
    maxOutputTokens !== undefined && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 0,
    window,
  )
  // dsh REFUSES this target (`TargetPressureConfigError`, not a clamp), so it reserves nothing and gets no masks.
  const pressureBudget = window - output - COMPACT_HEADROOM_TOKENS
  if (pressureBudget <= 0) return undefined
  const threshold = Math.min(Math.floor(window * COMPACT_THRESHOLD_RATIO), pressureBudget)
  return { threshold, headroom: COMPACT_HEADROOM_TOKENS, output }
}
