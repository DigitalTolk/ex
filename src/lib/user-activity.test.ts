import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isUserActive, markUserActivity, startUserActivityTracking } from './user-activity';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('user-activity', () => {
  beforeEach(() => {
    setVisibility('visible');
    markUserActivity();
    startUserActivityTracking(); // idempotent — repeated calls must not stack listeners
  });

  afterEach(() => {
    setVisibility('visible');
  });

  it('is active right after an interaction on a visible page', () => {
    markUserActivity(Date.now());
    expect(isUserActive(60_000)).toBe(true);
  });

  it('goes inactive once the last interaction falls outside the window', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    expect(isUserActive(2 * 60_000)).toBe(false);
  });

  it('a hidden page is always inactive, however recent the input', () => {
    markUserActivity(Date.now());
    setVisibility('hidden');
    expect(isUserActive(60_000)).toBe(false);
  });

  it('document input events stamp the activity clock', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    expect(isUserActive(60_000)).toBe(false);
    document.dispatchEvent(new Event('keydown', { bubbles: true }));
    expect(isUserActive(60_000)).toBe(true);
  });

  it('pointer movement counts as activity', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    document.dispatchEvent(new Event('pointermove', { bubbles: true }));
    expect(isUserActive(60_000)).toBe(true);
  });

  it('returning to the app (visibilitychange → visible) counts as activity', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(isUserActive(60_000)).toBe(true);
  });

  it('re-focusing the window counts as activity (cmd-tab back fires focus without visibilitychange)', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    expect(isUserActive(60_000)).toBe(false);
    window.dispatchEvent(new Event('focus'));
    expect(isUserActive(60_000)).toBe(true);
  });

  it('going hidden does not stamp activity', () => {
    markUserActivity(Date.now() - 10 * 60_000);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    setVisibility('visible');
    expect(isUserActive(60_000)).toBe(false);
  });
});
