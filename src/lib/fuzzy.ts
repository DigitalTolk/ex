// Client-side fuzzy matching for in-memory lists (mention popup, future
// command palettes). Mirrors the backend's normalizeFuzzy in
// internal/search/search.go — keep both implementations behaviourally
// identical so client- and server-side filters agree.
//
// Matching strategy, in order of preference:
//   1. Substring of the candidate string — this also covers every token
//      prefix ("ali" in "Alice Smith", "noice" in "carla@noice.io"), since
//      a token is itself a substring of the candidate.
//   2. Damerau-Levenshtein ≤ 1 against any token, for queries ≥ 4 chars
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
// The table handles empty and identical inputs on its own (row/column 0
// hold the plain lengths), so no early returns are needed.
function damerauLevenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
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
    // Typo tolerance only kicks in on long-enough queries — otherwise it
    // would accept noise like a single typo'd character matching every
    // name. Tokens split on whitespace, dot, @, underscore and hyphen, so
    // "first.last", "user@domain", "snake_case" and "kebab-case" are
    // compared piece by piece.
    if (q.length < 4) continue;
    for (const tok of f.split(/[\s.@_-]+/)) {
      if (damerauLevenshtein(tok, q) <= 1) return true;
    }
  }
  return false;
}
