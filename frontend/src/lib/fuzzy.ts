// Client-side fuzzy matching for in-memory lists (mention popup, future
// command palettes). Mirrors the backend's normalizeFuzzy in
// internal/search/search.go — keep both implementations behaviourally
// identical so client- and server-side filters agree.
//
// Matching strategy, in order of preference:
//   1. Exact substring of the candidate string (cheap, common case).
//   2. Token-prefix: any token of the candidate starts with the query
//      (so "ali" matches "Alice Smith", "noice" matches "carla@noice.io").
//   3. Damerau-Levenshtein ≤ 1 against any token, for queries ≥ 4 chars
//      — handles 1-char typos including swapped neighbouring keys.
//
// All comparisons run on lowercased + normalized strings.

export function normalizeFuzzy(s: string): string {
  if (s.length < 3) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    let j = i + 1;
    while (j < s.length && s[j] === c) j++;
    out += j - i >= 3 ? c : s.slice(i, j);
    i = j;
  }
  return out;
}

// Damerau-Levenshtein distance (insert / delete / substitute /
// adjacent-transposition). Distance 1 covers the most common typing
// mistakes including swapped neighbouring keys ("Aliec" → "Alice").
function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = [];
  for (let i = 0; i <= m; i++) {
    d[i] = new Array<number>(n + 1).fill(0);
    d[i][0] = i;
  }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i >= 2 && j >= 2 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// fuzzyMatch returns true when the query "looks like" any of the
// fields. Empty queries match everything (callers typically pre-filter
// to avoid showing a zero-character popup).
export function fuzzyMatch(query: string, ...fields: string[]): boolean {
  const q = normalizeFuzzy(query.trim().toLowerCase());
  if (q === '') return true;
  for (const field of fields) {
    if (!field) continue;
    const f = normalizeFuzzy(field.toLowerCase());
    if (f.includes(q)) return true;
    // Token-prefix and Damerau-Levenshtein only kick in on long-enough
    // queries — otherwise they'd accept noise like a single typo'd
    // character matching every name.
    if (q.length >= 2) {
      // Split on whitespace, dot, @, underscore, hyphen — covers
      // "first.last", "user@domain", "snake_case", and "kebab-case"
      // so token-prefix matches the inside of structured strings.
      for (const tok of f.split(/[\s.@_-]+/)) {
        if (tok.startsWith(q)) return true;
        if (q.length >= 4 && damerauLevenshtein(tok, q) <= 1) return true;
      }
    }
  }
  return false;
}
