import { describe, expect, it } from 'vitest';
import hljs from 'highlight.js/lib/core';
import { REGISTERED_HIGHLIGHT_LANGUAGES, codeFenceLabel, supportedHighlightLanguage } from './code-fence';
import { grammars, isRegisteredHighlightLanguage } from './code-highlight';

describe('code-fence', () => {
  // The synchronous list must name exactly what the lazily loaded highlighter
  // registers: a missing name renders a supported fence plain, an extra one
  // gives an unsupported fence a gutter it never fills.
  it('lists exactly the grammar names and aliases the highlighter registers', () => {
    const registered = new Set(
      Object.entries(grammars).flatMap(([name, grammar]) => [
        name,
        ...(grammar(hljs).aliases ?? []).map((alias) => alias.toLowerCase()),
      ]),
    );
    expect([...REGISTERED_HIGHLIGHT_LANGUAGES].sort()).toEqual([...registered].sort());
    for (const name of REGISTERED_HIGHLIGHT_LANGUAGES) expect(isRegisteredHighlightLanguage(name)).toBe(true);
  });

  it('answers for a grammar alias the fence table does not map', () => {
    expect(supportedHighlightLanguage('jsx')).toBe('jsx');
    expect(codeFenceLabel('TSX')).toBe('TSX');
    expect(codeFenceLabel('brainfuck')).toBe('plain');
  });
});
