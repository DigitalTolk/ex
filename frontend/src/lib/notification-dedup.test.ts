import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { hasSeenNotification, recordNotification, resetNotificationDedup } from './notification-dedup';

const T0 = 1_000_000_000_000;
const WINDOW_MS = 5 * 60_000;

describe('notification-dedup', () => {
  beforeEach(() => {
    resetNotificationDedup();
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a recorded messageID as seen', () => {
    expect(hasSeenNotification('m-1', T0)).toBe(false);
    recordNotification('m-1', T0);
    expect(hasSeenNotification('m-1', T0)).toBe(true);
  });

  it('does not treat distinct messageIDs as duplicates', () => {
    recordNotification('m-1', T0);
    expect(hasSeenNotification('m-2', T0)).toBe(false);
  });

  it('expires an entry once it ages past the dedup window', () => {
    recordNotification('m-old', T0);
    expect(hasSeenNotification('m-old', T0 + WINDOW_MS - 1)).toBe(true);
    expect(hasSeenNotification('m-old', T0 + WINDOW_MS + 1)).toBe(false);
  });

  it('shares the seen-set across tabs via localStorage', () => {
    // Two "tabs" are two calls against the same backing localStorage — a record
    // from one is visible to the other.
    recordNotification('m-shared', T0);
    const raw = localStorage.getItem('ex.notif.seen.v1');
    expect(raw).toContain('m-shared');
    expect(hasSeenNotification('m-shared', T0 + 1000)).toBe(true);
  });

  it('caps the stored set, evicting the oldest entries', () => {
    // Record 510 entries with increasing timestamps; the cap is 500, so the 10
    // oldest are pruned and re-fire.
    for (let i = 0; i < 510; i++) {
      recordNotification(`m-${i}`, T0 + i);
    }
    const now = T0 + 510;
    expect(hasSeenNotification('m-0', now)).toBe(false); // oldest — evicted
    expect(hasSeenNotification('m-9', now)).toBe(false); // still within the evicted window
    expect(hasSeenNotification('m-509', now)).toBe(true); // newest — kept
  });

  it('prunes expired entries on write so storage stays flat', () => {
    recordNotification('m-stale', T0);
    // A much later write should drop the stale entry from the persisted map.
    recordNotification('m-fresh', T0 + WINDOW_MS + 1000);
    const raw = localStorage.getItem('ex.notif.seen.v1') ?? '';
    expect(raw).toContain('m-fresh');
    expect(raw).not.toContain('m-stale');
  });

  it('falls back to an in-memory map when localStorage writes throw, without diverging', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    // Write latches to memory-only; the read path must also use memory so the
    // record is still seen (no divergence that would leak a duplicate through).
    recordNotification('m-mem', T0);
    expect(setItem).toHaveBeenCalled();
    expect(hasSeenNotification('m-mem', T0)).toBe(true);
  });

  it('falls back to memory when localStorage reads throw', () => {
    recordNotification('m-pre', T0);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    // First read trips the latch and returns the in-memory mirror (which has the
    // earlier record) rather than throwing.
    expect(hasSeenNotification('m-pre', T0)).toBe(true);
  });

  it('treats a corrupt localStorage payload as empty rather than throwing', () => {
    localStorage.setItem('ex.notif.seen.v1', '{not valid json');
    expect(() => hasSeenNotification('m-x', T0)).not.toThrow();
    expect(hasSeenNotification('m-x', T0)).toBe(false);
  });

  it('treats a non-object localStorage payload as empty', () => {
    localStorage.setItem('ex.notif.seen.v1', '"a string"');
    expect(hasSeenNotification('m-x', T0)).toBe(false);
  });
});
