interface CacheEntry { value: unknown; expires: number }

const caches = new WeakMap<object, Map<string, CacheEntry>>();

function bucket(owner: object): Map<string, CacheEntry> {
  let map = caches.get(owner);
  if (!map) { map = new Map(); caches.set(owner, map); }
  return map;
}

export function cacheRead<T>(owner: object, key: string, now = Date.now()): T | undefined {
  const map = caches.get(owner);
  const entry = map?.get(key);
  if (!entry) return undefined;
  if (entry.expires <= now) { map!.delete(key); return undefined; }
  return entry.value as T;
}

export function cacheWrite<T>(owner: object, key: string, value: T, ttlMs: number, now = Date.now()): void {
  bucket(owner).set(key, { value, expires: now + ttlMs });
}

export function cacheDrop(owner: object, prefix?: string): void {
  const map = caches.get(owner);
  if (!map) return;
  if (!prefix) { map.clear(); return; }
  for (const key of Array.from(map.keys())) if (key.startsWith(prefix)) map.delete(key);
}
