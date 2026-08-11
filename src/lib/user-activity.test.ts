import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  attentionWindowMs,
  clockJumpMs,
  forceAwayUntilInput,
  isHardAway,
  isUserAttentive,
  isWindowFocused,
  markUserActivity,
  resetUserActivityForTests,
  setActivityBroadcast,
  setAttentionBroadcast,
  setHardAway,
  startUserActivityTracking,
  suppressionWindowMs,
  wakeProbeIntervalMs,
} from './user-activity';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function focusWindow() {
  window.dispatchEvent(new Event('focus'));
}

describe('user-activity (attention model)', () => {
  beforeEach(() => {
    resetUserActivityForTests();
    setVisibility('visible');
    startUserActivityTracking(); // idempotent — repeated calls must not stack listeners
    startUserActivityTracking();
    // jsdom boots with document.hasFocus() === false; attention needs focus.
    focusWindow();
    markUserActivity();
  });

  afterEach(() => {
    resetUserActivityForTests();
    setVisibility('visible');
  });

  it('is attentive right after input on a visible, focused page', () => {
    expect(isUserAttentive(60_000)).toBe(true);
  });

  it('goes inattentive once the last input falls outside the window', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    expect(isUserAttentive(2 * 60_000)).toBe(false);
  });

  it('a hidden page is never attentive, however recent the input', () => {
    setVisibility('hidden');
    expect(isUserAttentive(60_000)).toBe(false);
  });

  it('a blurred window is never attentive, however recent the input (R4)', () => {
    window.dispatchEvent(new Event('blur'));
    expect(isWindowFocused()).toBe(false);
    expect(isUserAttentive(60_000)).toBe(false);
    focusWindow();
    expect(isUserAttentive(60_000)).toBe(true);
  });

  it('document input events stamp the activity clock', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    expect(isUserAttentive(60_000)).toBe(false);
    document.dispatchEvent(new Event('keydown', { bubbles: true }));
    expect(isUserAttentive(60_000)).toBe(true);
  });

  it('pointer movement counts as input', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    document.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(isUserAttentive(60_000)).toBe(true);
  });

  it('R1: re-focusing the window does NOT stamp the activity clock (unlock/alt-tab is not proof of a human)', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    window.dispatchEvent(new Event('blur'));
    focusWindow();
    // Focused again, but the input clock must still be stale — the old
    // focus-stamps-activity behavior was GAP-6 (a fresh 20-minute "active"
    // window with zero human input after every screen unlock).
    expect(isWindowFocused()).toBe(true);
    expect(isUserAttentive(60_000)).toBe(false);
  });

  it('R1: visibilitychange → visible does NOT stamp the activity clock', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isUserAttentive(60_000)).toBe(false);
  });

  it('R2: a hard-away signal forces away immediately regardless of fresh input, and clears on release', () => {
    expect(isHardAway()).toBe(false);
    setHardAway('shell', true);
    expect(isHardAway()).toBe(true);
    expect(isUserAttentive(60_000)).toBe(false);
    // Independent sources stack — clearing one keeps the other latched.
    setHardAway('idle-detector', true);
    setHardAway('shell', false);
    expect(isHardAway()).toBe(true);
    setHardAway('idle-detector', false);
    expect(isHardAway()).toBe(false);
    expect(isUserAttentive(60_000)).toBe(true);
  });

  it('R3: the wake latch forces away until the next real input', () => {
    forceAwayUntilInput();
    forceAwayUntilInput(); // idempotent
    expect(isHardAway()).toBe(true);
    expect(isUserAttentive(60_000)).toBe(false);
    // Focus alone must not clear it — only real input does.
    focusWindow();
    expect(isUserAttentive(60_000)).toBe(false);
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(isHardAway()).toBe(false);
    expect(isUserAttentive(60_000)).toBe(true);
  });

  it('R3: a clock jump (system sleep) latches away-until-input via the wake probe', () => {
    vi.useFakeTimers();
    try {
      resetUserActivityForTests();
      startUserActivityTracking();
      // Normal ticks: the probe fires on schedule, gaps stay at the interval.
      vi.advanceTimersByTime(wakeProbeIntervalMs * 2);
      expect(isHardAway()).toBe(false);
      // Sleep: the wall clock jumps with NO intervening ticks (timers were
      // frozen), then the machine wakes and the next tick observes the gap.
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
      vi.advanceTimersByTime(wakeProbeIntervalMs);
      expect(isHardAway()).toBe(true);
      // Real input clears the latch (R3).
      document.dispatchEvent(new Event('keydown', { bubbles: true }));
      expect(isHardAway()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('broadcasts activity stamps and attention flips to the registered seams', () => {
    const stamps: number[] = [];
    let flips = 0;
    setActivityBroadcast((at) => stamps.push(at));
    setAttentionBroadcast(() => {
      flips++;
    });
    markUserActivity(123);
    expect(stamps).toEqual([123]);
    setHardAway('shell', true);
    setHardAway('shell', true); // no state change — no extra flip
    window.dispatchEvent(new Event('blur'));
    focusWindow();
    expect(flips).toBe(3); // hard-away on, blur, focus
    setActivityBroadcast(null);
    setAttentionBroadcast(null);
  });

  it('startUserActivityTracking falls back to focused=true when hasFocus is unavailable', () => {
    resetUserActivityForTests();
    const orig = document.hasFocus;
    // @ts-expect-error — simulating an environment without hasFocus
    document.hasFocus = undefined;
    try {
      startUserActivityTracking();
      expect(isWindowFocused()).toBe(true);
    } finally {
      document.hasFocus = orig;
    }
  });

  it('exports a coherent window lattice (I-11): suppression <= attention', () => {
    expect(suppressionWindowMs).toBeLessThanOrEqual(attentionWindowMs);
    expect(clockJumpMs).toBeGreaterThan(0);
    expect(wakeProbeIntervalMs).toBeGreaterThan(0);
  });
});
