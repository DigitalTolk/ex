import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  clearUnreadAnchor,
  endReadSession,
  getUnreadAnchor,
  holdRead,
  isAtBottom,
  isReadHeld,
  keepReadSession,
  releaseRead,
  scheduleEndReadSession,
  setAtBottom,
  setUnreadAnchor,
  threadReadKey,
  useUnreadAnchor,
} from './read-position';

afterEach(() => {
  for (const key of ['ch-1', 'ch-2', threadReadKey('root-1')]) endReadSession(key);
  vi.useRealTimers();
});

describe('read-position', () => {
  it('keeps the first anchor of a visit unless told to replace it', () => {
    setUnreadAnchor('ch-1', { kind: 'count', count: 3 });
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'later' });
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'count', count: 3 });
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-2' }, { replace: true });
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'message', messageID: 'm-2' });
    clearUnreadAnchor('ch-1');
    clearUnreadAnchor('ch-1'); // already gone: no-op
    expect(getUnreadAnchor('ch-1')).toBeUndefined();
  });

  it('tracks holds and the live-tail position per chat, both reset when the visit ends', () => {
    expect(isReadHeld('ch-1')).toBe(false);
    expect(isAtBottom('ch-1')).toBe(true);
    holdRead('ch-1');
    setAtBottom('ch-1', false);
    expect(isReadHeld('ch-1')).toBe(true);
    expect(isAtBottom('ch-1')).toBe(false);
    expect(isAtBottom('ch-2')).toBe(true);
    releaseRead('ch-1');
    setAtBottom('ch-1', true);
    expect(isReadHeld('ch-1')).toBe(false);
    expect(isAtBottom('ch-1')).toBe(true);

    holdRead('ch-1');
    setAtBottom('ch-1', false);
    setUnreadAnchor('ch-1', { kind: 'count', count: 1 });
    endReadSession('ch-1');
    expect([isReadHeld('ch-1'), isAtBottom('ch-1'), getUnreadAnchor('ch-1')]).toEqual([false, true, undefined]);
  });

  it('defers ending a visit a tick, and an immediate remount keeps it (StrictMode)', () => {
    vi.useFakeTimers();
    setUnreadAnchor('ch-1', { kind: 'count', count: 2 });
    scheduleEndReadSession('ch-1');
    keepReadSession('ch-1');
    keepReadSession('ch-1'); // nothing pending: no-op
    vi.runAllTimers();
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'count', count: 2 });

    scheduleEndReadSession('ch-1');
    scheduleEndReadSession('ch-1'); // re-scheduling replaces the pending end
    vi.runAllTimers();
    expect(getUnreadAnchor('ch-1')).toBeUndefined();
  });

  it('useUnreadAnchor re-renders on changes and reads nothing without a key', () => {
    const { result, rerender } = renderHook(({ k }: { k?: string }) => useUnreadAnchor(k), {
      initialProps: { k: threadReadKey('root-1') },
    });
    expect(result.current).toBeUndefined();
    act(() => setUnreadAnchor(threadReadKey('root-1'), { kind: 'after', at: '2026-10-07T09:00:00Z' }));
    expect(result.current).toEqual({ kind: 'after', at: '2026-10-07T09:00:00Z' });
    rerender({ k: undefined });
    expect(result.current).toBeUndefined();
  });
});
