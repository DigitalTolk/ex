import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDesktopPresence,
  PRESENCE_CHANGED_EVENT,
  PRESENCE_STATE_ATTR,
  resetDesktopPresenceForTests,
} from './desktop-presence';
import {
  isHardAway,
  isUserAtDevice,
  isUserAttentive,
  markUserActivity,
  resetUserActivityForTests,
  startUserActivityTracking,
} from './user-activity';

function shellReports(state: string): void {
  document.documentElement.setAttribute(PRESENCE_STATE_ATTR, state);
  document.dispatchEvent(new Event(PRESENCE_CHANGED_EVENT));
}

describe('desktop-presence', () => {
  beforeEach(() => {
    resetDesktopPresenceForTests();
    resetUserActivityForTests();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    window.__EX_DESKTOP__ = true;
  });

  afterEach(() => {
    resetDesktopPresenceForTests();
    resetUserActivityForTests();
    delete (window as Window & { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
  });

  it('is inert outside the desktop shell (no __EX_DESKTOP__)', () => {
    delete (window as Window & { __EX_DESKTOP__?: boolean }).__EX_DESKTOP__;
    initDesktopPresence();
    shellReports('locked');
    expect(isHardAway()).toBe(false);
  });

  it('applies shell state already stamped before the SPA booted', () => {
    document.documentElement.setAttribute(PRESENCE_STATE_ATTR, 'locked');
    initDesktopPresence();
    expect(isHardAway()).toBe(true);
  });

  it('locked / suspended latch hard-away; unknown or unsupported release it (R2)', () => {
    initDesktopPresence();
    for (const away of ['locked', 'suspended']) {
      shellReports(away);
      expect(isHardAway(), `state=${away}`).toBe(true);
      shellReports('unsupported');
      expect(isHardAway(), `release after ${away}`).toBe(false);
    }
    shellReports('locked');
    shellReports('some-future-state');
    expect(isHardAway()).toBe(false);
  });

  // THE REGRESSION (2026-08-12): the shell flags 'idle' after only 60s of OS
  // quiet — a user reading a thread trips it while sitting at the desk.
  // Mapping it to hard-away made the desktop refuse to ack every alert
  // ~90s into reading anything, so the phone buzzed constantly. 'idle' is
  // absence of fresh evidence, not proof of absence: it must release any
  // latched hard-away and leave the ack decision to the input-recency
  // window.
  it("shell 'idle' is NOT hard-away — a user 60s into reading still acks via the input window", () => {
    startUserActivityTracking();
    initDesktopPresence();
    // Last real input 2 minutes ago (they scrolled, then started reading).
    markUserActivity(Date.now() - 2 * 60_000);
    shellReports('idle');
    expect(isHardAway()).toBe(false);
    // Still at the device for the ACK tier (10-min window)…
    expect(isUserAtDevice(10 * 60_000)).toBe(true);
    // …but 15 minutes of OS quiet (no re-stamps) ages out and the phone
    // rightly takes over.
    markUserActivity(Date.now() - 15 * 60_000);
    expect(isUserAtDevice(10 * 60_000)).toBe(false);
  });

  it("shell 'idle' releases a previously latched hard-away (lock → idle never wedges away)", () => {
    initDesktopPresence();
    shellReports('locked');
    expect(isHardAway()).toBe(true);
    shellReports('idle');
    expect(isHardAway()).toBe(false);
  });

  it('active releases hard-away AND stamps the activity clock (OS input evidence)', () => {
    startUserActivityTracking();
    window.dispatchEvent(new Event('focus'));
    initDesktopPresence();
    shellReports('locked');
    // Simulate stale page input: OS unlock produces no page events, but the
    // shell saw real OS input (idle time reset) and reports active.
    markUserActivity(Date.now() - 30 * 60_000);
    expect(isUserAttentive(10 * 60_000)).toBe(false);
    shellReports('active');
    expect(isHardAway()).toBe(false);
    expect(isUserAttentive(10 * 60_000)).toBe(true);
  });

  it('init is idempotent (a second init does not double-apply)', () => {
    initDesktopPresence();
    initDesktopPresence();
    shellReports('locked');
    expect(isHardAway()).toBe(true);
    resetDesktopPresenceForTests();
    // After reset the listener is gone — events change nothing.
    shellReports('locked');
    expect(isHardAway()).toBe(false);
  });
});
