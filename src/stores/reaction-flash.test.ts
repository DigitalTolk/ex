import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { flashReaction, getReactionFlash, REACTION_FLASH_MS, useReactionFlash } from './reaction-flash';
import { resetAllStores } from '@/test/store-reset';

describe('reaction flash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the emoji for a moment, then clears', () => {
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders += 1;
      return useReactionFlash();
    });
    const before = renders;
    act(() => flashReaction(':tada:'));
    expect(result.current?.emoji).toBe(':tada:');
    expect(getReactionFlash()?.emoji).toBe(':tada:');
    expect(renders).toBe(before + 1);
    act(() => {
      vi.advanceTimersByTime(REACTION_FLASH_MS);
    });
    expect(result.current).toBeNull();
    expect(getReactionFlash()).toBeNull();
    expect(renders).toBe(before + 2);
    unmount();
    flashReaction(':eyes:');
    expect(renders).toBe(before + 2);
  });

  it('restarts the clock on a second reaction and tells a repeat apart', () => {
    flashReaction(':tada:');
    const first = getReactionFlash()!.seq;
    vi.advanceTimersByTime(REACTION_FLASH_MS - 100);
    flashReaction(':tada:');
    expect(getReactionFlash()!.seq).toBeGreaterThan(first);
    vi.advanceTimersByTime(200);
    expect(getReactionFlash()?.emoji).toBe(':tada:');
    vi.advanceTimersByTime(REACTION_FLASH_MS);
    expect(getReactionFlash()).toBeNull();
  });

  it('ignores an empty emoji', () => {
    flashReaction('');
    expect(getReactionFlash()).toBeNull();
  });

  it('a flash timer still running across a store reset leaves the next flash alone', () => {
    flashReaction(':wave:');
    resetAllStores();
    vi.advanceTimersByTime(REACTION_FLASH_MS / 2);
    flashReaction(':ok:');
    // The first flash's timer fires now; it clears only its own flash.
    vi.advanceTimersByTime(REACTION_FLASH_MS / 2);
    expect(getReactionFlash()?.emoji).toBe(':ok:');
    vi.advanceTimersByTime(REACTION_FLASH_MS / 2);
    expect(getReactionFlash()).toBeNull();
  });
});

// The flash is a zustand store: the per-test reset clears what a test left.
describe('reaction flash between tests', () => {
  it('a test leaves a flash showing', () => {
    flashReaction(':wave:');
    expect(getReactionFlash()?.emoji).toBe(':wave:');
  });

  it('the next test starts with none', () => {
    expect(getReactionFlash()).toBeNull();
  });
});
