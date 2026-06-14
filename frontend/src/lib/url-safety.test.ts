import { describe, it, expect } from 'vitest';
import { isSafeUrl } from './url-safety';

describe('isSafeUrl', () => {
  it('allows http/https/mailto absolute URLs (case-insensitive scheme)', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
    expect(isSafeUrl('HTTPS://EXAMPLE.COM')).toBe(true);
    expect(isSafeUrl('mailto:x@example.com')).toBe(true);
  });

  it('rejects dangerous schemes', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('allows relative, anchor and query references (no scheme)', () => {
    expect(isSafeUrl('/path/to/page')).toBe(true); // leading slash
    expect(isSafeUrl('#section')).toBe(true); // anchor first
    expect(isSafeUrl('?q=1')).toBe(true); // query first
    expect(isSafeUrl('relative/path')).toBe(true); // no colon at all
    expect(isSafeUrl('//cdn.example.com')).toBe(true); // scheme-relative
  });

  it('treats a non-scheme char before a colon as relative/safe', () => {
    // A space before the colon is not a valid scheme char → relative.
    expect(isSafeUrl('a b:c')).toBe(true);
  });

  it('rejects empty/whitespace-only input', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
  });
});
