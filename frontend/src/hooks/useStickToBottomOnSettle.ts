import { useLayoutEffect, type RefObject } from 'react';

interface Options {
  // Element to scroll. The hook writes scrollTop = scrollHeight on it.
  scrollRef: RefObject<HTMLElement | null>;
  // Inner content container. Search root for the per-image
  // re-stick-after-decode pass; size changes outside this subtree
  // (sidebar avatars, etc.) shouldn't trigger sticks.
  innerRef: RefObject<HTMLElement | null>;
  // Pulse signal — every change re-arms the chase. Pass
  // `allMessages.length` so the chase fires when messages first
  // land. Internal dedup (doneRef) prevents later page-load bumps
  // from yanking a reader who already scrolled up.
  pulse: number;
  // Per-session dedup ref. Caller resets `current = false` on
  // channel/anchor change so the next session re-sticks; the hook
  // flips it to true after firing.
  doneRef: RefObject<boolean>;
  // At-bottom flag, shared with the scroll listener that maintains
  // it. The hook writes `true` after the synchronous stick lands and
  // reads it every frame inside the chase to bail when the user
  // takes scroll control.
  atBottomRef: RefObject<boolean>;
  // When true, suppress the chase entirely (deep-link mode owns
  // scroll position there).
  disabled: boolean;
}

const STABILITY_FRAMES = 5;
const MAX_DURATION_MS = 3000;

// useStickToBottomOnSettle drives a "stick to the live tail until
// content stops settling" behaviour. The synchronous stick fires
// once per session (gated by doneRef); a multi-stage chase then
// re-sticks across:
//
//   1. document.fonts.ready (web font swap-in shifts text height).
//   2. Image decode completion for every <img> currently in the
//      inner container (cached and uncached).
//   3. A self-terminating rAF loop until either scrollHeight has
//      been stable for STABILITY_FRAMES consecutive frames or
//      MAX_DURATION_MS wall-clock elapses.
//
// Every stage re-checks atBottomRef so the moment the user takes
// scroll control, the chase backs off. The whole thing is
// cancelled on effect re-run / unmount via the returned cleanup.
export function useStickToBottomOnSettle({
  scrollRef,
  innerRef,
  pulse,
  doneRef,
  atBottomRef,
  disabled,
}: Options): void {
  useLayoutEffect(() => {
    if (disabled) return;
    if (pulse === 0) return;
    if (doneRef.current) return;
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;

    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    doneRef.current = true;

    const cancel = { cancelled: false };
    const startTime = now();

    const stickIfAtBottom = () => {
      if (cancel.cancelled) return false;
      if (!atBottomRef.current) return false;
      el.scrollTop = el.scrollHeight;
      return true;
    };

    let lastHeight = el.scrollHeight;
    let stableCount = 0;
    const tick = () => {
      if (!stickIfAtBottom()) return;
      const h = el.scrollHeight;
      if (h === lastHeight) {
        if (++stableCount >= STABILITY_FRAMES) return;
      } else {
        stableCount = 0;
        lastHeight = h;
      }
      if (now() - startTime > MAX_DURATION_MS) return;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        stickIfAtBottom();
      }).catch(() => {/* noop */});
    }

    for (const img of Array.from(inner.querySelectorAll('img'))) {
      const onSettle = () => stickIfAtBottom();
      if (typeof img.decode === 'function') {
        img.decode().then(onSettle, onSettle);
      } else if (img.complete) {
        Promise.resolve().then(onSettle);
      } else {
        img.addEventListener('load', onSettle, { once: true });
        img.addEventListener('error', onSettle, { once: true });
      }
    }

    return () => {
      cancel.cancelled = true;
    };
  }, [pulse, disabled, scrollRef, innerRef, doneRef, atBottomRef]);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
