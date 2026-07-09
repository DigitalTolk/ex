import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  TypingProvider,
  useTyping,
  threadTypingKey,
  formatTypingPhrase,
} from './TypingContext';

describe('threadTypingKey', () => {
  it('joins parent and thread root with a pipe', () => {
    expect(threadTypingKey('p', 'r')).toBe('p|r');
  });
});

describe('formatTypingPhrase', () => {
  it('renders the right phrasing for each count', () => {
    expect(formatTypingPhrase([])).toBe('');
    expect(formatTypingPhrase(['A'])).toBe('A is typing…');
    expect(formatTypingPhrase(['A', 'B'])).toBe('A and B are typing…');
    expect(formatTypingPhrase(['A', 'B', 'C'])).toBe('A, B and C are typing…');
    expect(formatTypingPhrase(['A', 'B', 'C', 'D'])).toBe('A, B and 2 others are typing…');
    expect(formatTypingPhrase(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('Lots of people are typing…');
  });
});

describe('TypingProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    return renderHook(() => useTyping(), { wrapper: TypingProvider });
  }

  it('records and clears typing in a parent', () => {
    const { result } = setup();
    act(() => result.current.recordTyping('ch-1', 'u-2'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2']);

    // Recording the same entry again refreshes it without duplicating.
    act(() => result.current.recordTyping('ch-1', 'u-2'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2']);

    act(() => result.current.clearTyping('ch-1', 'u-2'));
    expect(result.current.typingByParent['ch-1']).toBeUndefined();
  });

  it('records typing in a thread under its composite key', () => {
    const { result } = setup();
    act(() => result.current.recordTyping('ch-1', 'u-2', 'root-1'));
    expect(result.current.typingByThread[threadTypingKey('ch-1', 'root-1')]).toEqual(['u-2']);
  });

  it('ignores empty parent or user IDs on record and clear', () => {
    const { result } = setup();
    act(() => result.current.recordTyping('', 'u-2'));
    act(() => result.current.recordTyping('ch-1', ''));
    act(() => result.current.clearTyping('', 'u-2'));
    expect(result.current.typingByParent).toEqual({});
  });

  it('is a no-op when clearing an entry that does not exist', () => {
    const { result } = setup();
    act(() => result.current.recordTyping('ch-1', 'u-2'));
    act(() => result.current.clearTyping('ch-1', 'nobody'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2']);
  });

  it('excludes the current user from typing lists', () => {
    const { result } = setup();
    act(() => result.current.setSelfUserID('u-self'));
    act(() => result.current.recordTyping('ch-1', 'u-self'));
    act(() => result.current.recordTyping('ch-1', 'u-other'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-other']);
  });

  it('replaces a same-length typing list when one user supersedes another', () => {
    const { result } = setup();
    vi.setSystemTime(0);
    act(() => result.current.recordTyping('ch-1', 'u-2'));
    act(() => result.current.recordTyping('ch-1', 'u-3'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2', 'u-3']);

    // Refresh u-2 at t=3000 so it outlives u-3 (whose entry expires at 6000).
    vi.setSystemTime(3000);
    act(() => result.current.recordTyping('ch-1', 'u-2'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2', 'u-3']);

    // At t=7000 u-3 has lapsed; recording u-4 rebuilds to a list of the same
    // length [u-2, u-4] differing only at index 1 — exercising the element-wise
    // inequality branch of shallowEqualByKey (no interval tick fires because we
    // move the clock with setSystemTime rather than advancing timers).
    vi.setSystemTime(7000);
    act(() => result.current.recordTyping('ch-1', 'u-4'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2', 'u-4']);
  });

  it('expires entries on the interval tick', () => {
    const { result } = setup();
    act(() => result.current.recordTyping('ch-1', 'u-2'));
    expect(result.current.typingByParent['ch-1']).toEqual(['u-2']);
    // Advance well past the expiry window so the 1Hz sweep drops the entry.
    act(() => vi.advanceTimersByTime(20_000));
    expect(result.current.typingByParent['ch-1']).toBeUndefined();
  });
});
