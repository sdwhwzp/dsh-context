/** The one plain-object re-proof every untrusted payload passes before a field is read; arrays are excluded because they are objects at
 * runtime but carry no keyed record. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
