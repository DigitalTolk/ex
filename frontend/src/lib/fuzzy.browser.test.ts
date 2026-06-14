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
});
