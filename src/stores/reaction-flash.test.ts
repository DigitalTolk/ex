import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashReaction, getReactionFlash, REACTION_FLASH_MS, resetReactionFlashForTests, subscribeReactionFlash } from './reaction-flash';

describe('reaction flash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetReactionFlashForTests();
  });
  afterEach(() => {
    resetReactionFlashForTests();
    vi.useRealTimers();
  });

  it('shows the emoji for a moment, then clears', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeReactionFlash(onChange);
    flashReaction(':tada:');
    expect(getReactionFlash()?.emoji).toBe(':tada:');
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REACTION_FLASH_MS);
    expect(getReactionFlash()).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    flashReaction(':eyes:');
    expect(onChange).toHaveBeenCalledTimes(2);
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
});
