/** The host-wide cold-read governor: every cold read materializes a whole durable log, so the gate admits one at a time (FIFO) and only
 * below the heap ceiling; a skipped read takes the caller's designed no-data path, never a visible failure. */

import { getHeapStatistics } from 'node:v8'

export interface HeapReading {
  used: number
  limit: number
}

export interface ColdReadGate {
  /** Resolves `undefined` when the read was skipped under pressure — the caller's no-data path answers instead. */
  admit<T>(read: () => Promise<T>): Promise<T | undefined>
}

/** Two-thirds of the process's own V8 ceiling; the top third is headroom for the read and the harness's own logs. */
const HIGH_WATER = 2 / 3

function v8Reading(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit }
}

const noop = (): void => {}

/** One governor per host process. `reading` is injectable for tests; a throwing or garbage probe fails OPEN, since the meter must never
 * block a read. */
export function makeColdReadGate(reading: () => HeapReading = v8Reading): ColdReadGate {
  const clear = (): boolean => {
    try {
      const { used, limit } = reading()
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true
      return used < limit * HIGH_WATER
    } catch {
      return true
    }
  }
  let tail: Promise<unknown> = Promise.resolve()
  return {
    admit<T>(read: () => Promise<T>): Promise<T | undefined> {
      // The headroom check runs at the front of the queue, not at queue time — pressure changes while waiting.
      const run = tail.then(() => (clear() ? read() : undefined))
      tail = run.then(noop, noop)
      return run
    },
  }
}
