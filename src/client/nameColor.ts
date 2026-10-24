/** The name-hash dot/bar palette shared by the Skills list (overviewSkills.tsx) and the command panel's Programs
 * ranking: one stable color per name across every surface. */

const NAME_COLORS = [
  'var(--color-blue-500)',
  'var(--color-green-500)',
  'var(--color-purple-500)',
  'var(--color-orange-500)',
  'var(--color-teal-500)',
  'var(--color-pink-500)',
  'var(--color-indigo-500)',
  'var(--color-amber-500)',
] as const

/** Stable name-hash color (djb2) — deterministic, so a name keeps its color across lists and sessions. */
export function nameColorOf(name: string): string {
  let hash = 5381
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0
  return NAME_COLORS[hash % NAME_COLORS.length]
}
