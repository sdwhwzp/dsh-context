import type { Assembled } from '../assemble'
import type { Category, RequestRecord, SurfaceNode } from '../../shared/types'
import type { RowKind } from './browserNodes'

export interface CatFocus {
  cat: string
  kind?: RowKind
  /** The step to show; absent lands on the live surface. */
  step?: number
}

export function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.system !== null ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

export function lastOfTurn(requests: RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

/** Entry stamp of a surface item: the FIRST request logged after its seq carried it (assemble includes
 * `n.seq < R.seq`); no following request stamps null. */
export function stepStampOf(requests: RequestRecord[]): (itemSeq: number) => { turn: number; step: number } | null {
  // Sort a copy: restored rows can re-order, so the derivation must not trust wire append order.
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq)
  return (itemSeq) => {
    for (const r of sorted) {
      if (r.seq > itemSeq) {
        return typeof r.turn === 'number' && typeof r.step === 'number' ? { turn: r.turn, step: r.step } : null
      }
    }
    return null
  }
}

/** Bands keep at least this share of the occupied region so a tiny item stays a hoverable filament, not a sub-pixel
 * sliver; tooltips still report true shares. */
export const DNA_MIN_BAND = 0.35
