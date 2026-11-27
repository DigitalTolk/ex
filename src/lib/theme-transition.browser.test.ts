import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetThemeRevealForTests, revealTheme } from './theme-transition';

// The dancing-gopher reveal in a real browser: the bundled GIF loads, the
// view transition runs, and the new page's snapshot is masked by it.

const supported = typeof (document as Document & { startViewTransition?: unknown }).startViewTransition === 'function';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  resetThemeRevealForTests();
  vi.restoreAllMocks();
});

describe('theme reveal in a real browser', () => {
  it('masks the new theme with the gopher, or just switches where it cannot', async () => {
    const root = document.documentElement;
    const animations: Animation[] = [];
    const real = root.animate.bind(root);
    const animate = vi.spyOn(root, 'animate').mockImplementation((frames, options) => {
      const animation = real(frames, options);
      animations.push(animation);
      return animation;
    });
    let applied = false;
    const animated = await revealTheme(() => {
      applied = true;
      root.classList.add('dark');
    });
    expect(animated).toBe(supported);
    // The browser runs the change once it has the old page's snapshot.
    await expect.poll(() => applied).toBe(true);
    expect(root.classList.contains('dark')).toBe(true);
    if (!supported) return;
    await expect.poll(() => animate.mock.calls.length).toBe(1);
    const [frames, options] = animate.mock.calls[0] as [Keyframe[], KeyframeAnimationOptions];
    expect(options.pseudoElement).toBe('::view-transition-new(root)');
    expect(String(frames[0].maskImage)).toMatch(/^url\("blob:/);
    // The browser took the keyframes: the reveal is playing on the snapshot.
    expect((animations[0].effect as KeyframeEffect).pseudoElement).toBe('::view-transition-new(root)');
    expect(animations[0].playState).toBe('running');
    animations[0].finish();
  });
});
