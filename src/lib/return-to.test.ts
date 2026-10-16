import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSafeReturnPath, rememberReturnTo, RETURN_TO_TTL_MS, takeReturnTo } from './return-to';

const FALLBACK = '/channel/general';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('isSafeReturnPath', () => {
  it('admits same-origin app paths only', () => {
    expect(isSafeReturnPath('/runner/connect?port=4000')).toBe(true);
    expect(isSafeReturnPath('https://evil.example/')).toBe(false);
    expect(isSafeReturnPath('//evil.example/')).toBe(false);
    expect(isSafeReturnPath('/\\evil.example/')).toBe(false);
    expect(isSafeReturnPath('/login')).toBe(false);
    expect(isSafeReturnPath('/oidc/callback')).toBe(false);
  });
});

describe('remember / take', () => {
  it('returns the remembered path once, then falls back', () => {
    rememberReturnTo('/runner/connect?port=4000', 1000);
    expect(takeReturnTo(FALLBACK, 2000)).toBe('/runner/connect?port=4000');
    expect(takeReturnTo(FALLBACK, 2000)).toBe(FALLBACK);
  });

  it('defaults both clocks to now', () => {
    rememberReturnTo('/runner/connect');
    expect(takeReturnTo(FALLBACK)).toBe('/runner/connect');
  });

  it('ignores a stale, unsafe, or garbled entry', () => {
    rememberReturnTo('/runner/connect', 0);
    expect(takeReturnTo(FALLBACK, RETURN_TO_TTL_MS)).toBe(FALLBACK);
    rememberReturnTo('//evil.example', 0);
    expect(takeReturnTo(FALLBACK, 1)).toBe(FALLBACK);
    sessionStorage.setItem('ex:return-to', '{not json');
    expect(takeReturnTo(FALLBACK)).toBe(FALLBACK);
    sessionStorage.setItem('ex:return-to', JSON.stringify({ path: 7, at: 'x' }));
    expect(takeReturnTo(FALLBACK)).toBe(FALLBACK);
  });

  it('survives storage that refuses to work', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberReturnTo('/runner/connect')).not.toThrow();
    expect(takeReturnTo(FALLBACK)).toBe(FALLBACK);
  });
});
