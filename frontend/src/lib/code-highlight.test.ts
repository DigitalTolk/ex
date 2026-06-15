import { describe, it, expect } from 'vitest';
import { normalizeHighlightLanguage, highlightToHast } from './code-highlight';

describe('normalizeHighlightLanguage', () => {
  it('returns undefined for missing or empty input', () => {
    expect(normalizeHighlightLanguage(undefined)).toBeUndefined();
    expect(normalizeHighlightLanguage('')).toBeUndefined();
    expect(normalizeHighlightLanguage('   ')).toBeUndefined();
  });

  it('maps known aliases to their grammar name', () => {
    expect(normalizeHighlightLanguage('JS')).toBe('javascript');
    expect(normalizeHighlightLanguage('ts')).toBe('typescript');
    expect(normalizeHighlightLanguage('sh')).toBe('bash');
    expect(normalizeHighlightLanguage('c++')).toBe('cpp');
    expect(normalizeHighlightLanguage('html')).toBe('xml');
  });

  it('passes through an unaliased language lowercased', () => {
    expect(normalizeHighlightLanguage('PHP')).toBe('php');
    expect(normalizeHighlightLanguage('rust')).toBe('rust');
  });
});

describe('highlightToHast', () => {
  it('returns null when no language is given', () => {
    expect(highlightToHast('const x = 1', undefined)).toBeNull();
  });

  it('returns null for an unregistered language', () => {
    expect(highlightToHast('whatever', 'no-such-language')).toBeNull();
  });

  it('returns a hast tree for a registered language', () => {
    const tree = highlightToHast('<?php echo "hi"; ?>', 'php');
    expect(tree).not.toBeNull();
    expect(tree?.type).toBe('root');
    expect(Array.isArray(tree?.children)).toBe(true);
  });

  it('resolves an alias before highlighting', () => {
    const tree = highlightToHast('const x = 1;', 'js');
    expect(tree).not.toBeNull();
  });
});
