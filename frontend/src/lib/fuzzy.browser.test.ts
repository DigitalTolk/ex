import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from './fuzzy';

// Browser-gate coverage for fuzzyMatch (token-prefix + Damerau-Levenshtein
// typo tolerance). Only a jsdom test existed previously.

describe('fuzzyMatch (browser)', () => {
  it('an empty query matches everything', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true);
  });

  it('matches a plain substring', () => {
    expect(fuzzyMatch('oh', 'john')).toBe(true);
  });

  it('matches a token prefix inside a structured string', () => {
    // "john.doe" splits into [john, doe]; "doe".startsWith("do").
    expect(fuzzyMatch('do', 'john.doe')).toBe(true);
  });

  it('tolerates a single transposition typo on a long-enough query', () => {
    // "jhon" → "john" is one Damerau-Levenshtein transposition.
    expect(fuzzyMatch('jhon', 'john')).toBe(true);
  });

  it('handles an empty leading token (separator-prefixed field)', () => {
    // "_john" splits into ['', 'john']; the empty token drives the
    // levenshtein m===0 base case before the real token prefix-matches.
    expect(fuzzyMatch('john', '_john')).toBe(true);
  });

  it('rejects an unrelated query', () => {
    expect(fuzzyMatch('zzzz', 'john')).toBe(false);
  });

  it('skips empty fields without matching', () => {
    expect(fuzzyMatch('john', '')).toBe(false);
  });

  it('tolerates a single substitution typo on a 4-char query (Damerau distance 1)', () => {
    // "johnny" token vs "johm" (≥4 chars): substring/prefix both miss, then
    // damerauLevenshtein("johnny","johm")... use a tighter pair so distance is
    // exactly 1: token "alan" vs query "alon" (one substitution).
    expect(fuzzyMatch('alon', 'alan')).toBe(true);
  });

  it('rejects a long query whose Damerau distance exceeds 1 (the <= 1 false side)', () => {
    // "abcd" (≥4) vs token "wxyz": every substring/prefix check misses and the
    // edit distance is 4 (> 1), so the `damerauLevenshtein(tok, q) <= 1` false
    // side runs and the candidate is rejected.
    expect(fuzzyMatch('abcd', 'wxyz here')).toBe(false);
  });

  it('does not apply typo tolerance to short (2-3 char) queries', () => {
    // "abc" is ≥2 (token-prefix runs) but < 4, so the Damerau arm is skipped;
    // an unrelated 3-char query against a non-prefixed token stays unmatched.
    expect(fuzzyMatch('abc', 'xyz')).toBe(false);
  });

  it('matches a long query against the second token of a multi-token field via distance', () => {
    // Field "carla noice": query "noice" exact-substring matches; "noyce"
    // (one substitution) reaches the token loop and matches "noice" by
    // distance 1 — exercising the walk into later tokens.
    expect(fuzzyMatch('noyce', 'carla noice')).toBe(true);
  });
});
