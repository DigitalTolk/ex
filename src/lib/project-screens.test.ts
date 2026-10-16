import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESIGN_NOTES_TEMPLATE,
  SCREEN_STALE_DAYS,
  groupByPage,
  guessViewport,
  isStale,
  pageNameFromFilename,
  readImageSize,
} from './project-screens';

describe('pageNameFromFilename', () => {
  it.each([
    ['booking-detail_mobile@2x.png', 'Booking detail'],
    ['Screenshot 2026-10-01 at 10.22.31.png', ''],
    ['settings.page.desktop.PNG', 'Settings page'],
    ['dashboard copy.jpg', 'Dashboard'],
    ['BOOKINGS.webp', 'Bookings'],
    ['.png', ''],
  ])('%s → %s', (file, want) => {
    expect(pageNameFromFilename(file)).toBe(want);
  });
});

describe('guessViewport', () => {
  it('reads the filename first, then the aspect ratio', () => {
    expect(guessViewport('home-iphone.png')).toBe('mobile');
    expect(guessViewport('home.png', 390, 844)).toBe('mobile');
    expect(guessViewport('home.png', 1440, 900)).toBe('desktop');
    expect(guessViewport('home.png', 0, 0)).toBe('desktop');
    expect(guessViewport('home.png')).toBe('desktop');
  });
});

describe('isStale', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  it('flags screenshots older than the threshold only', () => {
    const old = new Date(now.getTime() - (SCREEN_STALE_DAYS + 1) * 86_400_000).toISOString();
    const fresh = new Date(now.getTime() - 86_400_000).toISOString();
    expect(isStale(old, now)).toBe(true);
    expect(isStale(fresh, now)).toBe(false);
    expect(isStale(undefined, now)).toBe(false);
    expect(isStale('not a date', now)).toBe(false);
  });
});

describe('groupByPage', () => {
  it('groups case-insensitively, keeping first-seen order and label', () => {
    const groups = groupByPage([
      { page: 'Home', id: 1 },
      { page: 'Settings', id: 2 },
      { page: 'home ', id: 3 },
    ]);
    expect(groups.map((g) => [g.page, g.screens.map((s) => s.id)])).toEqual([
      ['Home', [1, 3]],
      ['Settings', [2]],
    ]);
  });
});

describe('DESIGN_NOTES_TEMPLATE', () => {
  it('asks for the values a screenshot cannot carry', () => {
    expect(DESIGN_NOTES_TEMPLATE).toContain('UI stack (component library, icons):');
    expect(DESIGN_NOTES_TEMPLATE).toContain('Font:');
    expect(DESIGN_NOTES_TEMPLATE).toContain('Things the agent gets wrong:');
  });
});

describe('readImageSize', () => {
  const realImage = globalThis.Image;
  afterEach(() => {
    globalThis.Image = realImage;
    vi.restoreAllMocks();
  });

  function stubImage(outcome: 'load' | 'error') {
    class FakeImage {
      naturalWidth = 1440;
      naturalHeight = 900;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => (outcome === 'load' ? this.onload?.() : this.onerror?.()));
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image;
    const revoke = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: revoke });
    return revoke;
  }

  it('resolves the decoded size and releases the object URL', async () => {
    const revoke = stubImage('load');
    await expect(readImageSize(new File(['x'], 'a.png'))).resolves.toEqual({ width: 1440, height: 900 });
    expect(revoke).toHaveBeenCalledWith('blob:x');
    vi.unstubAllGlobals();
  });

  it('resolves 0×0 when the image cannot decode', async () => {
    const revoke = stubImage('error');
    await expect(readImageSize(new File(['x'], 'a.png'))).resolves.toEqual({ width: 0, height: 0 });
    expect(revoke).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
