/** Page-lifetime Map hygiene shared by the seq/session-keyed caches: re-inserting moves an entry to the newest end, so
 * a trim always targets the least recently used key. */

/** Mark a key freshly used; an absent key needs no work (the caller inserts). */
export function lruTouch<K, T>(map: Map<K, T>, key: K): void {
  const known = map.get(key)
  if (known === undefined) return
  map.delete(key)
  map.set(key, known)
}

/** Drop the least recently used entries past the cap. The count is explicit: a negative `slice` bound wraps from the
 * end and would empty the map. */
export function lruTrim<K, T>(map: Map<K, T>, max: number): void {
  let excess = map.size - max
  if (excess <= 0) return
  for (const key of map.keys()) {
    if (excess <= 0) break
    map.delete(key)
    excess--
  }
}
