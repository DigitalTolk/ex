import { describe, it, expect } from 'vitest';
import { cn, isHttpUrl } from './utils';

describe('cn', () => {
  it('merges conditional classes and resolves tailwind conflicts', () => {
    const hidden = false as boolean;
    expect(cn('p-2', hidden && 'hidden', 'p-4')).toBe('p-4');
  });
});

describe('isHttpUrl', () => {
  it('accepts absolute http/https URLs', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('rejects script-injection schemes', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>')).toBe(false);
  });

  it('rejects empty or whitespace-containing input', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('http://exa mple.com')).toBe(false);
  });

  it('rejects non-URL text that fails to parse (relative refs included)', () => {
    // `new URL(...)` throws for these → the catch returns false.
    expect(isHttpUrl('notaurl')).toBe(false);
    expect(isHttpUrl('/relative/path')).toBe(false);
  });
});
