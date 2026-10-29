import { describe, it, expect } from 'vitest';
import { normalizeFuzzy, fuzzyMatch, matchRank, rankedMatches } from './fuzzy';

describe('normalizeFuzzy', () => {
  it('collapses runs of 3+ identical characters', () => {
    expect(normalizeFuzzy('Noiceeee')).toBe('Noice');
    expect(normalizeFuzzy('soooo')).toBe('so');
    expect(normalizeFuzzy('aaa')).toBe('a');
  });

  it('preserves legitimate doubles', () => {
    expect(normalizeFuzzy('letter')).toBe('letter');
    expect(normalizeFuzzy('happy')).toBe('happy');
    expect(normalizeFuzzy('book')).toBe('book');
  });

  it('returns short strings unchanged', () => {
    expect(normalizeFuzzy('')).toBe('');
    expect(normalizeFuzzy('a')).toBe('a');
    expect(normalizeFuzzy('aa')).toBe('aa');
  });
});

describe('fuzzyMatch', () => {
  it('matches plain substrings of any field', () => {
    expect(fuzzyMatch('alice', 'Alice', 'alice@example.com')).toBe(true);
    expect(fuzzyMatch('example', 'Alice', 'alice@example.com')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(fuzzyMatch('ALICE', 'alice')).toBe(true);
    expect(fuzzyMatch('alice', 'Alice')).toBe(true);
  });

  it('matches token prefixes inside multi-word names', () => {
    expect(fuzzyMatch('john', 'Dave Johnson')).toBe(true);
    expect(fuzzyMatch('jo', 'Dave Johnson')).toBe(true);
  });

  it('matches tokens that appear after dots/dashes/at-signs in emails', () => {
    expect(fuzzyMatch('jane', 'Other', 'jane.doe@x.com')).toBe(true);
    expect(fuzzyMatch('doe', 'Other', 'jane.doe@x.com')).toBe(true);
    expect(fuzzyMatch('x', 'Other', 'jane.doe@x.com')).toBe(true);
  });

  it('handles elongation typos via normalization on both sides', () => {
    expect(fuzzyMatch('Aliceeee', 'Alice')).toBe(true);
    expect(fuzzyMatch('Alice', 'Aliceeee')).toBe(true);
  });

  it('tolerates a single-char typo on long-enough queries', () => {
    expect(fuzzyMatch('Aliec', 'Alice')).toBe(true);
    expect(fuzzyMatch('Alize', 'Alice')).toBe(true);
    expect(fuzzyMatch('Alic', 'Alice')).toBe(true);
  });

  it('does not pretend a wildly different query matches', () => {
    expect(fuzzyMatch('Bob', 'Alice', 'alice@x.com')).toBe(false);
    expect(fuzzyMatch('zzzz', 'Alice')).toBe(false);
  });

  it('returns true for empty queries (popup callers gate this themselves)', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true);
  });

  it('skips blank fields gracefully', () => {
    expect(fuzzyMatch('alice', '', 'alice@x.com')).toBe(true);
    expect(fuzzyMatch('alice', 'Alice', '')).toBe(true);
  });
});

describe('matchRank', () => {
  it('ranks the name itself, then prefixes, substrings, typos and other fields', () => {
    expect(matchRank('incident', 'incident')).toBe(0);
    expect(matchRank('Incident ', 'INCIDENT')).toBe(0);
    expect(matchRank('incident', 'incidents-2025')).toBe(1);
    expect(matchRank('incident', 'major-incident')).toBe(2);
    expect(matchRank('incident', 'incidnet')).toBe(3);
    expect(matchRank('incident', 'inc-1042', 'Incident: payments down')).toBe(4);
    expect(matchRank('incident', 'random', 'off-topic')).toBe(-1);
  });

  it('ranks everything alike for an empty query', () => {
    expect(matchRank('', 'anything')).toBe(0);
    expect(matchRank('  ', 'anything', 'else')).toBe(0);
  });
});

describe('rankedMatches', () => {
  const channels = [
    { name: 'inc-1042', topic: 'Incident: payments down' },
    { name: 'random', topic: 'off-topic' },
    { name: 'incidents-2025', topic: '' },
    { name: 'incident', topic: '' },
    { name: 'incidents-2024', topic: '' },
  ];

  it('keeps the matches, best first, equal matches in their order', () => {
    expect(rankedMatches(channels, 'incident', (c) => [c.name, c.topic]).map((c) => c.name)).toEqual([
      'incident',
      'incidents-2025',
      'incidents-2024',
      'inc-1042',
    ]);
  });

  it('matches only the fields it is given', () => {
    expect(rankedMatches(channels, 'incident', (c) => [c.name]).map((c) => c.name)).toEqual([
      'incident',
      'incidents-2025',
      'incidents-2024',
    ]);
  });
});
