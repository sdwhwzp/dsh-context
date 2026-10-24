// A driver over the session-projection registry's DOCUMENTED semantics, mirrored from dsh's
// `packages/session/session-projection` at each supported tag; every supported line shares one contract.

interface ErasedDefinition {
  key: string
  stateSchema: { parse(value: unknown): unknown }
  init(header: unknown, inheritedEventCount: number): unknown
  apply(state: unknown, event: unknown): unknown
  wire: { viewSchema: { parse(value: unknown): unknown }; view(state: unknown): unknown } | undefined
  stateVersion: number
}

export interface DefinitionLike {
  key: string
  stateSchema: { parse(value: unknown): unknown }
  init(...args: unknown[]): unknown
  apply(state: unknown, event: unknown): unknown
  wire?: { viewSchema: { parse(value: unknown): unknown }; view(state: unknown): unknown }
  stateVersion: number
}

interface UnitCell {
  state: unknown
  observedSeq: number
}

export interface SessionLike {
  seq: number
  header: unknown
  /** Inherited event count from pre-identity log compaction; the registry hands it to `init`. */
  inheritedEventCount: number
  events: unknown[]
}

export type ChangeListener = (session: SessionLike, key: string, value: unknown) => void

export interface ProjectionSnapshot {
  asOfSeq: number
  values: Record<string, unknown>
}

export interface CheckpointRow {
  ver: number
  seq: number
  val: unknown
}

export type Checkpoint = Record<string, CheckpointRow>

/** Register-time rule violations: non-negative safe-integer `stateVersion`, and a shared key must agree on it. */
export class RegistryViolationError extends Error {}

/** The plain-JSON persistence gate: the projection cache's own write precondition (mirrored in the fold helpers). */
import { snapshotJson } from '../helpers/projection'

export class RegistryDriver {
  private readonly registrations = new Map<string, { def: ErasedDefinition; cells: Map<SessionLike, UnitCell> }>()
  private readonly listeners = new Set<ChangeListener>()

  register(definition: DefinitionLike): () => void {
    if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0) {
      throw new RegistryViolationError(`stateVersion must be a non-negative integer, got ${String(definition.stateVersion)}`)
    }
    const rawWire = definition.wire
    const wire = rawWire === undefined ? undefined : {
      viewSchema: rawWire.viewSchema,
      view: (state: unknown) => rawWire.view(state),
    }
    const def: ErasedDefinition = {
      key: definition.key,
      stateSchema: definition.stateSchema,
      // The registry calls init(header, inheritedEventCount); the plugin's zero-argument init observes neither argument.
      init: (header, inheritedEventCount) => definition.init(header, inheritedEventCount),
      apply: (state, event) => definition.apply(state, event),
      wire,
      stateVersion: definition.stateVersion,
    }
    const existing = this.registrations.get(def.key)
    if (existing === undefined) {
      this.registrations.set(def.key, { def, cells: new Map() })
    } else {
      if (existing.def.stateVersion !== def.stateVersion) {
        throw new RegistryViolationError(`key ${JSON.stringify(def.key)} is already registered at stateVersion ${String(existing.def.stateVersion)}`)
      }
    }
    return () => {
      this.registrations.delete(def.key)
    }
  }

  onChanged(listener: ChangeListener): void {
    this.listeners.add(listener)
  }

  /** The `session/created` eager seeding (seq-0 sessions only). */
  sessionCreated(session: SessionLike): void {
    if (session.seq !== 0) return
    for (const { def, cells } of this.registrations.values()) {
      if (cells.has(session)) continue
      cells.set(session, { state: def.init(session.header, session.inheritedEventCount), observedSeq: -1 })
    }
  }

  driveEvent(session: SessionLike, event: { seq: number }): void {
    for (const { def, cells } of this.registrations.values()) {
      let cell = cells.get(session)
      if (cell !== undefined && cell.observedSeq >= event.seq) continue
      if (cell === undefined) {
        cell = { state: def.init(session.header, session.inheritedEventCount), observedSeq: -1 }
        cells.set(session, cell)
      }
      const previous = cell.state
      this.advanceCell(def, cell, session.events, event.seq)
      if (cell.state !== previous && def.wire !== undefined) {
        const value = def.wire.viewSchema.parse(def.wire.view(cell.state))
        for (const listener of this.listeners) listener(session, def.key, value)
      }
    }
  }

  snapshot(session: SessionLike): ProjectionSnapshot {
    const values: Record<string, unknown> = {}
    for (const { def, cells } of this.registrations.values()) {
      if (def.wire === undefined) continue
      let cell = cells.get(session)
      if (cell === undefined) {
        cell = { state: def.init(session.header, session.inheritedEventCount), observedSeq: -1 }
        cells.set(session, cell)
      }
      this.advanceCell(def, cell, session.events, session.seq - 1)
      values[def.key] = def.wire.viewSchema.parse(def.wire.view(cell.state))
    }
    return { asOfSeq: session.seq - 1, values }
  }

  /** The persisted-cache write face: `ver/seq/val` rows, structurally cloned. */
  checkpoint(session: SessionLike): Checkpoint {
    const rows: Checkpoint = {}
    for (const { def, cells } of this.registrations.values()) {
      let cell = cells.get(session)
      if (cell === undefined) {
        cell = { state: def.init(session.header, session.inheritedEventCount), observedSeq: -1 }
        cells.set(session, cell)
      }
      this.advanceCell(def, cell, session.events, session.seq - 1)
      rows[def.key] = { ver: def.stateVersion, seq: cell.observedSeq, val: structuredClone(cell.state) as unknown }
    }
    return rows
  }

  /** The projection cache's WRITE precondition: every row must be losslessly JSON-serializable or the whole write
   * fails with a TypeError. Returns the detached JSON image. */
  checkpointJson(session: SessionLike): Record<string, unknown> | undefined {
    return snapshotJson(this.checkpoint(session)) as Record<string, unknown> | undefined
  }

  /** Cold-read rung: schema-validated views of ver-matching rows; bad rows stay absent. */
  viewCheckpoint(checkpoint: Checkpoint): Record<string, unknown> {
    const values: Record<string, unknown> = {}
    for (const { def } of this.registrations.values()) {
      if (def.wire === undefined) continue
      const row = checkpoint[def.key]
      if (row === undefined || row.ver !== def.stateVersion) continue
      let state: unknown
      try {
        state = def.stateSchema.parse(row.val)
      } catch {
        continue
      }
      values[def.key] = def.wire.viewSchema.parse(def.wire.view(state))
    }
    return values
  }

  /** The persisted-cache read anchor (one below the lowest usable watermark). */
  restoreFloor(checkpoint: Checkpoint): number | undefined {
    let floor: number | undefined
    for (const { def } of this.registrations.values()) {
      const row = checkpoint[def.key]
      const need = row !== undefined && row.ver === def.stateVersion ? Math.max(row.seq + 1, 0) : 0
      floor = floor === undefined ? need : Math.min(floor, need)
    }
    return floor === undefined ? undefined : Math.max(floor - 1, 0)
  }

  /** Cold read: seed usable rows through stateSchema.parse, refold the rest. */
  restore(checkpoint: Checkpoint, events: { seq: number }[], baseSeq: number, header: unknown, inheritedEventCount = 0): ProjectionSnapshot {
    const endSeq = events.at(-1)?.seq ?? baseSeq - 1
    const values: Record<string, unknown> = {}
    for (const { def } of this.registrations.values()) {
      const row = checkpoint[def.key]
      const usable = row !== undefined
        && row.ver === def.stateVersion
        && row.seq >= baseSeq - 1
        && row.seq <= endSeq
      if (!usable && baseSeq > 0) {
        throw new RegistryViolationError(`${def.key} cannot restore from seq ${baseSeq}: re-read from seq 0`)
      }
      let state = usable ? def.stateSchema.parse(row.val) : def.init(header, inheritedEventCount)
      const from = usable ? row.seq : baseSeq - 1
      for (let index = from - baseSeq + 1; index < events.length; index++) {
        state = def.apply(state, events[index])
      }
      if (def.wire !== undefined) values[def.key] = def.wire.viewSchema.parse(def.wire.view(state))
    }
    return { asOfSeq: endSeq, values }
  }

  /** Advance one cell through a contiguous log prefix (registry rule: no gaps). */
  private advanceCell(def: ErasedDefinition, cell: UnitCell, events: unknown[], throughSeq: number): void {
    if (cell.observedSeq >= throughSeq) return
    for (let seq = cell.observedSeq + 1; seq <= throughSeq; seq++) {
      const event = events[seq]
      if (event === undefined || (event as { seq: number }).seq !== seq) {
        throw new RegistryViolationError(`${def.key} cannot advance across missing seq ${seq}`)
      }
      cell.state = def.apply(cell.state, event)
      cell.observedSeq = seq
    }
  }
}
