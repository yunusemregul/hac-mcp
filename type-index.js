// ─── Per-environment ComposedType index with trigram fuzzy search ─────────────
//
// Trigram similarity (PostgreSQL-style):
//   score = |intersection(trigrams(a), trigrams(b))| / |union(trigrams(a), trigrams(b))|
// Plus a bonus for exact substring containment so "Order" still ranks OrderEntry high.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// envId → { types: string[], fetchedAt: number, promise?: Promise }
const cache = new Map();

// ─── Trigram helpers ──────────────────────────────────────────────────────────
function trigrams(str) {
  // Pad with two spaces on each side (standard PostgreSQL padding)
  const s = `  ${str.toLowerCase()}  `;
  const set = new Set();
  for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
  return set;
}

function trigramSimilarity(a, b) {
  const ta = trigrams(a);
  const tb = trigrams(b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Scoring: trigram + substring bonus ──────────────────────────────────────
function score(query, candidate) {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let s = trigramSimilarity(q, c);
  // Exact substring match bonus (like LIKE '%q%' but boosted)
  if (c.includes(q)) s += 0.3;
  // Prefix match bonus
  if (c.startsWith(q)) s += 0.2;
  return s;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Populate (or refresh) the index for an environment.
 * flexSearchFn: (query, opts?) => Promise<{ resultList, exception }>
 */
export async function refreshIndex(envId, flexSearchFn) {
  const result = await flexSearchFn(
    `SELECT {code} FROM {ComposedType} ORDER BY {code} ASC`,
    { maxCount: 5000 }
  );
  if (result.exception) throw new Error(result.exception.message || JSON.stringify(result.exception));
  const types = (result.resultList || []).map(([code]) => code);
  cache.set(envId, { types, fetchedAt: Date.now() });
  return types;
}

/**
 * Get the cached index, fetching if missing or stale.
 * flexSearchFn: bound to the env's session
 */
export async function getIndex(envId, flexSearchFn) {
  const entry = cache.get(envId);
  if (entry && !entry.promise && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.types;
  }
  // Deduplicate concurrent fetches
  if (entry?.promise) return entry.promise;
  const promise = refreshIndex(envId, flexSearchFn)
    .finally(() => { if (cache.get(envId)?.promise) delete cache.get(envId).promise; });
  cache.set(envId, { ...(entry || { types: [], fetchedAt: 0 }), promise });
  return promise;
}

/** Invalidate an env's cache (call after schema changes or on demand). */
export function invalidateIndex(envId) {
  cache.delete(envId);
}

/**
 * Fuzzy search the index.
 * Returns up to `topN` results with score > threshold, sorted by score desc.
 */
export function fuzzySearch(query, types, { topN = 20, threshold = 0.1 } = {}) {
  const scored = types
    .map(t => ({ type: t, score: score(query, t) }))
    .filter(x => x.score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return scored.map(x => x.type);
}
