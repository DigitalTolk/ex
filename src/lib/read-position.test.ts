import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  clearMissedArrivals,
  clearUnreadAnchor,
  endReadSession,
  getUnreadAnchor,
  holdRead,
  isAtBottom,
  isAtLiveTail,
  isReadHeld,
  keepReadSession,
  noteMissedArrival,
  releaseRead,
  scheduleEndReadSession,
  setAtBottom,
  setAtLiveTail,
  setUnreadAnchor,
  threadReadKey,
  useMissedArrivals,
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

  it('counts arrivals a link-opened window could not show, until cleared or the visit ends', () => {
    expect(isAtLiveTail('ch-1')).toBe(true);
    setAtLiveTail('ch-1', false);
    expect(isAtLiveTail('ch-1')).toBe(false);
    const { result, rerender } = renderHook(({ k }: { k?: string }) => useMissedArrivals(k), {
      initialProps: { k: 'ch-1' as string | undefined },
    });
    expect(result.current).toBe(0);
    act(() => {
      noteMissedArrival('ch-1');
      noteMissedArrival('ch-1');
    });
    expect(result.current).toBe(2);
    act(() => clearMissedArrivals('ch-1'));
    clearMissedArrivals('ch-1'); // nothing left: no-op
    expect(result.current).toBe(0);
    act(() => noteMissedArrival('ch-1'));
    act(() => endReadSession('ch-1'));
    expect(result.current).toBe(0);
    expect(isAtLiveTail('ch-1')).toBe(true);
    setAtLiveTail('ch-1', true);
    expect(isAtLiveTail('ch-1')).toBe(true);
    rerender({ k: undefined });
    expect(result.current).toBe(0);
  });
});
