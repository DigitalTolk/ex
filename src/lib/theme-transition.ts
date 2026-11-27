// The dancing Go gopher by Egon Elbre (github.com/egonelbre/gophers, CC0).
// The Go gopher was designed by Renée French (CC BY 4.0).
import gopherURL from '@/assets/theme-reveal-gopher.gif';

// The theme switch's reveal: the new theme shows through a dancing gopher.
// The View Transitions API snapshots the old page and the new one, and the
// new one is masked by the animated GIF: only where the gopher is opaque
// does the new theme show. The gopher pops up in the middle of the window,
// dances, then grows until it covers everything. Where the browser has no
// view transitions, the reader asked for less motion, or the GIF can't load,
// the theme simply changes.

export const THEME_REVEAL_MS = 2200;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let gif: Promise<Blob> | null = null;

// The GIF, fetched once. A failed fetch is forgotten, so the next switch
// tries again.
function loadGopher(): Promise<Blob> {
  gif ??= fetch(gopherURL).then((res) => {
    if (!res.ok) throw new Error(`theme reveal gopher: ${res.status}`);
    return res.blob();
  });
  gif.catch(() => {
    gif = null;
  });
  return gif;
}

// preloadThemeReveal fetches the GIF ahead of the first switch (the settings
// page calls it when it opens), so the switch doesn't wait on the network.
export function preloadThemeReveal(): void {
  loadGopher().catch(() => undefined);
}

export function resetThemeRevealForTests(): void {
  gif = null;
}

// The mask's sizes over the reveal: the gopher pops up (a bit past its size,
// then settles), dances, then grows until its middle covers the window. The
// middle of every frame is solid, and at that size the window sees only it.
function revealKeyframes(): Keyframe[] {
  const dance = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.5);
  const cover = Math.round(Math.hypot(window.innerWidth, window.innerHeight) * 14);
  return [
    { maskSize: '0px', offset: 0, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    { maskSize: `${dance}px`, offset: 0.14 },
    { maskSize: `${dance}px`, offset: 0.74, easing: 'cubic-bezier(0.7, 0, 0.84, 0)' },
    { maskSize: `${cover}px`, offset: 1 },
  ];
}

// revealTheme runs `apply` (which must change the page's theme at once, in
// the call) and, when it can, plays the gopher. Resolves to whether it
// animated.
export async function revealTheme(apply: () => void): Promise<boolean> {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    apply();
    return false;
  }
  // Each switch gets its own URL, so the dance starts from its first frame.
  // Decoded first, so the mask is ready on the transition's first frame.
  let url: string;
  try {
    url = URL.createObjectURL(await loadGopher());
    const image = new Image();
    image.src = url;
    await image.decode();
  } catch {
    apply();
    return false;
  }
  const transition = doc.startViewTransition(apply);
  transition.ready
    .then(() => {
      const mask = `url("${url}")`;
      document.documentElement.animate(
        revealKeyframes().map((frame) => ({ ...frame, maskImage: mask, maskPosition: 'center', maskRepeat: 'no-repeat' })),
        { duration: THEME_REVEAL_MS, fill: 'both', pseudoElement: '::view-transition-new(root)' },
      );
    })
    // A transition the browser skips (the tab hidden, another one started)
    // rejects `ready`; the theme has changed all the same.
    .catch(() => undefined);
  transition.finished.catch(() => undefined).finally(() => URL.revokeObjectURL(url));
  return true;
}
