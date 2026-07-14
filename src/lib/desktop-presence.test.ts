import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initDesktopPresence,
  PRESENCE_CHANGED_EVENT,
  PRESENCE_STATE_ATTR,
  resetDesktopPresenceForTests,
} from './desktop-presence';
import {
  isHardAway,
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

  it('locked / suspended / idle latch hard-away; unknown or unsupported release it (R2)', () => {
    initDesktopPresence();
    for (const away of ['locked', 'suspended', 'idle']) {
      shellReports(away);
      expect(isHardAway(), `state=${away}`).toBe(true);
      shellReports('unsupported');
      expect(isHardAway(), `release after ${away}`).toBe(false);
    }
    shellReports('locked');
    shellReports('some-future-state');
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
