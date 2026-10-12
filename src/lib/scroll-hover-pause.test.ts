import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachScrollHoverPause, SCROLL_HOVER_PAUSE_MS } from './scroll-hover-pause';

describe('attachScrollHoverPause', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flags the scroller while scroll events keep coming and clears it after they stop', () => {
    const scroller = document.createElement('div');
    const detach = attachScrollHoverPause(scroller);

    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.dataset.scrolling).toBe('true');

    // Each further event restarts the settle timer: still scrolling.
    vi.advanceTimersByTime(SCROLL_HOVER_PAUSE_MS - 10);
    scroller.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(SCROLL_HOVER_PAUSE_MS - 10);
    expect(scroller.dataset.scrolling).toBe('true');

    vi.advanceTimersByTime(10);
    expect(scroller.dataset.scrolling).toBeUndefined();
    detach();
  });

  it('detaching mid-scroll clears the flag and stops listening', () => {
    const scroller = document.createElement('div');
    const detach = attachScrollHoverPause(scroller);
    scroller.dispatchEvent(new Event('scroll'));
    detach();
    expect(scroller.dataset.scrolling).toBeUndefined();

    scroller.dispatchEvent(new Event('scroll'));
    vi.runAllTimers();
    expect(scroller.dataset.scrolling).toBeUndefined();
  });

  it('detaching after the flag settled is a no-op', () => {
    const scroller = document.createElement('div');
    const detach = attachScrollHoverPause(scroller);
    scroller.dispatchEvent(new Event('scroll'));
    vi.runAllTimers();
    expect(() => detach()).not.toThrow();
  });
});
