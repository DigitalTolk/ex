import { describe, expect, it, afterEach } from 'vitest';
import { readString, writeString, removeKey, readJSON, writeJSON } from './storage';

// Browser-gate coverage for the SSR-safe localStorage wrappers, including the
// swallowed-error branches (private mode / quota) and the JSON paths.

const KEY = 'ex.storage.test';

afterEach(() => {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
});

describe('storage wrappers (browser)', () => {
  it('round-trips a string and removes it', () => {
    writeString(KEY, 'hello');
    expect(readString(KEY)).toBe('hello');
    removeKey(KEY);
    expect(readString(KEY)).toBeNull();
  });

  it('readJSON returns the fallback for a missing key and parses a present one', () => {
    expect(readJSON(KEY, { n: 1 })).toEqual({ n: 1 });
    writeJSON(KEY, { n: 2, s: 'x' });
    expect(readJSON(KEY, { n: 1 })).toEqual({ n: 2, s: 'x' });
  });

  it('readJSON returns the fallback when the stored value is not valid JSON', () => {
    writeString(KEY, 'not-json{');
    expect(readJSON(KEY, 'fallback')).toBe('fallback');
  });

  it('writeJSON silently skips values that cannot be serialised (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // JSON.stringify throws → the catch returns without writing.
    expect(() => writeJSON(KEY, circular)).not.toThrow();
    expect(readString(KEY)).toBeNull();
  });

  it('swallows access errors from getItem / setItem / removeItem', () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const origGet = proto.getItem;
    const origSet = proto.setItem;
    const origRemove = proto.removeItem;
    const boom = () => { throw new DOMException('denied', 'SecurityError'); };
    Object.defineProperty(proto, 'getItem', { configurable: true, value: boom });
    Object.defineProperty(proto, 'setItem', { configurable: true, value: boom });
    Object.defineProperty(proto, 'removeItem', { configurable: true, value: boom });
    try {
      // Each wrapper's try/catch swallows the throw.
      expect(readString(KEY)).toBeNull();
      expect(() => writeString(KEY, 'x')).not.toThrow();
      expect(() => removeKey(KEY)).not.toThrow();
    } finally {
      Object.defineProperty(proto, 'getItem', { configurable: true, value: origGet });
      Object.defineProperty(proto, 'setItem', { configurable: true, value: origSet });
      Object.defineProperty(proto, 'removeItem', { configurable: true, value: origRemove });
    }
  });
});
