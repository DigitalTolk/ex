import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preloadThemeReveal, resetThemeRevealForTests, revealTheme, THEME_REVEAL_MS } from './theme-transition';

// The theme switch's dancing-gopher reveal: when it plays, and that the theme
// always changes whether it plays or not.

type Transition = { ready: Promise<void>; finished: Promise<void> };

const doc = document as Document & { startViewTransition?: (update: () => void) => Transition };
let animate: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let reducedMotion = false;

function stubTransition(ready: Promise<void> = Promise.resolve(), finished: Promise<void> = Promise.resolve()) {
  const start = vi.fn((update: () => void) => {
    update();
    return { ready, finished };
  });
  doc.startViewTransition = start;
  return start;
}

beforeEach(() => {
  resetThemeRevealForTests();
  reducedMotion = false;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') && reducedMotion, addEventListener() {}, removeEventListener() {} }));
  fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['gif'], { type: 'image/gif' })) });
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:gopher-1');
  URL.revokeObjectURL = vi.fn();
  // jsdom has no decode(); the real one is covered by the browser test.
  HTMLImageElement.prototype.decode = vi.fn().mockResolvedValue(undefined);
  animate = vi.fn();
  document.documentElement.animate = animate as unknown as typeof document.documentElement.animate;
});

afterEach(() => {
  delete doc.startViewTransition;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('revealTheme', () => {
  it('just changes the theme where the browser has no view transitions', async () => {
    const apply = vi.fn();
    await expect(revealTheme(apply)).resolves.toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('just changes the theme for a reader who asked for less motion', async () => {
    reducedMotion = true;
    const start = stubTransition();
    const apply = vi.fn();
    await expect(revealTheme(apply)).resolves.toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it('just changes the theme when the gopher cannot load, and tries again next time', async () => {
    const start = stubTransition();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const apply = vi.fn();
    await expect(revealTheme(apply)).resolves.toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();

    await expect(revealTheme(vi.fn())).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('dances the gopher over the new theme: pops up, dances, then covers the window', async () => {
    const start = stubTransition();
    const apply = vi.fn();
    await expect(revealTheme(apply)).resolves.toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(animate).toHaveBeenCalled());
    const [frames, options] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(options).toMatchObject({ duration: THEME_REVEAL_MS, fill: 'both', pseudoElement: '::view-transition-new(root)' });
    // The gopher, centred, never tiled.
    for (const frame of frames) {
      expect(frame).toMatchObject({ maskImage: 'url("blob:gopher-1")', maskPosition: 'center', maskRepeat: 'no-repeat' });
    }
    const sizes = frames.map((frame) => parseFloat(String(frame.maskSize)));
    expect(sizes[0]).toBe(0);
    // Dances at one size, then grows far past the window.
    expect(sizes[1]).toBe(sizes[2]);
    expect(sizes[1]).toBeGreaterThan(0);
    expect(sizes[3]).toBeGreaterThan(Math.hypot(window.innerWidth, window.innerHeight) * 10);
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gopher-1'));
  });

  it('fetches the gopher once, even across switches and the preload', async () => {
    stubTransition();
    preloadThemeReveal();
    await revealTheme(vi.fn());
    await revealTheme(vi.fn());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the new theme when the browser skips the transition', async () => {
    const skipped = Promise.reject(new Error('skipped'));
    stubTransition(skipped, Promise.reject(new Error('skipped')));
    const apply = vi.fn();
    await expect(revealTheme(apply)).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
    expect(animate).not.toHaveBeenCalled();
  });
});

describe('preloadThemeReveal', () => {
  it('swallows a failed fetch', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(() => preloadThemeReveal()).not.toThrow();
    await Promise.resolve();
  });
});
