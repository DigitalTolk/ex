import { describe, it, expect } from 'vitest';
import { normalizeHighlightLanguage, supportedHighlightLanguage, highlightToHast } from './code-highlight';

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

describe('supportedHighlightLanguage', () => {
  it('returns the canonical name for a supported language or alias', () => {
    expect(supportedHighlightLanguage('js')).toBe('javascript');
    expect(supportedHighlightLanguage('PHP')).toBe('php');
    expect(supportedHighlightLanguage('html')).toBe('xml');
    expect(supportedHighlightLanguage('ini')).toBe('ini');
    expect(supportedHighlightLanguage('toml')).toBe('ini');
    expect(supportedHighlightLanguage('hcl')).toBe('hcl');
    expect(supportedHighlightLanguage('terraform')).toBe('hcl');
    expect(supportedHighlightLanguage('tf')).toBe('hcl');
  });

  it('returns undefined for an unknown or missing language', () => {
    expect(supportedHighlightLanguage('no-such-lang')).toBeUndefined();
    expect(supportedHighlightLanguage(undefined)).toBeUndefined();
    expect(supportedHighlightLanguage('')).toBeUndefined();
  });
});

describe('highlightToHast', () => {
  it('returns null when no language is given', () => {
    expect(highlightToHast('const x = 1', undefined)).toBeNull();
  });

  it('returns null for an unregistered language', () => {
    expect(highlightToHast('whatever', 'no-such-language')).toBeNull();
  });

  it('returns null when the highlighter itself throws (defensive catch)', () => {
    // lowlight rejects a non-string value outright; the catch converts that
    // into the plain-block fallback instead of crashing message rendering.
    expect(highlightToHast(123 as unknown as string, 'php')).toBeNull();
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

  it('highlights the newly added hcl, ini and html grammars', () => {
    expect(highlightToHast('resource "x" "y" {\n  name = "z" # c\n}', 'hcl')).not.toBeNull();
    expect(highlightToHast('resource "x" {}', 'terraform')).not.toBeNull();
    expect(highlightToHast('[section]\nkey = 1', 'ini')).not.toBeNull();
    expect(highlightToHast('<div class="x">hi</div>', 'html')).not.toBeNull();
  });
});
