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

// matchRank orders what a query matches, best first: the name itself (0),
// a name starting with it (1), a name containing it (2), a name a typo away
// (3), then a match only in the other fields (4); -1 when nothing matches.
// "incident" puts ~incident before ~inc-1234 whose description mentions an
// incident. An empty query ranks everything 0, keeping the list's order.
export function matchRank(query: string, name: string, ...others: string[]): number {
  const q = normalizeFuzzy(query.trim().toLowerCase());
  if (q === '') return 0;
  const n = normalizeFuzzy(name.toLowerCase());
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if (fuzzyMatch(query, name)) return 3;
  return fuzzyMatch(query, ...others) ? 4 : -1;
}

