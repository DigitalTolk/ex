import { useEffect, useSyncExternalStore } from 'react';
import { deviceKind } from '@/lib/device';
import { keyboardOverlap, readKeyboardHeight } from '@/lib/keyboard';
// How many px of the bottom of the screen the on-screen keyboard covers.
//
// iOS doesn't shrink the page for the keyboard: it PANS everything up so the
// focused field shows, which pushed the channel header (and the whole top of
// the app) off the screen. The app instead sizes its root to exactly the
// space left above the keyboard — `--ex-app-height` on <html>, in px — and
// undoes the pan that comes with the keyboard, so the header stays pinned to
// the top and the composer sits right on the keyboard.
//
// Exactly, and in px measured from the same viewport the keyboard is
// measured against: a root even a few px taller than what's visible leaves
// the caret under the keyboard, and iOS pans again to reveal it on every
// keystroke. And only once per keyboard: a pan while typing is iOS keeping
// the caret in view, never something to undo — undoing it (smoothly, back to
// the top) made the composer jump with every character typed.
//
// At once, not animated: the root used to glide to its new height while a
// smooth scroll undid the pan, two animations on different curves, and the
// composer bounced up and down between them (and the message list, resized
// on every frame of the glide, re-stuck to its bottom on every frame).
// Resized and un-panned in the same frame, the composer stays exactly where
// the pan put it, on the keyboard, and only the top of the app moves.
//
// Two sources: the Capacitor shell reports the native keyboard height
// (WKWebView's visualViewport ignores the keyboard), and mobile Safari
// shrinks the visualViewport.

let inset = 0;
const listeners = new Set<() => void>();

// About the length of the iOS keyboard's own slide: what a surface that
// follows the keyboard on its own (the search sheet) takes to do so.
export const KEYBOARD_SETTLE_MS = 250;

// After the keyboard comes up, how long its pan may still land (iOS can pan
// after the keyboard has reported in). Later pans are the caret's.
const LATE_PAN_MS = 1000;

// apply records what the keyboard covers and sizes the app root to what's
// left above it (`visible`, px). It returns whether the keyboard came up.
function apply(covered: number, visible: number): boolean {
  const root = document.documentElement;
  const next = Math.max(0, Math.round(covered));
  if (next > 0) root.style.setProperty('--ex-app-height', `${Math.round(visible)}px`);
  else root.style.removeProperty('--ex-app-height');
  if (next === inset) return false;
  const wasUp = inset > 0;
  inset = next;
  for (const l of listeners) l();
  return !wasUp && inset > 0;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, () => inset);
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

// Until when a pan still counts as the keyboard's (see LATE_PAN_MS).
let keyboardPanUntil = 0;

// iOS reveals a focused field by panning the whole page up as the keyboard
// comes. The root has just been sized to the space above the keyboard, so
// the pan is undone at once: the chat composer, at the bottom of the root,
// lands exactly where the pan had put it. A field in a scroller of its own (a
// thread card, a login form, a dialog) is then brought into view if the
// keyboard still covers it.
function settle() {
  if (window.scrollY !== 0) window.scrollTo({ top: 0, behavior: 'instant' });
  const field = document.activeElement;
  if (inset > 0 && field instanceof HTMLElement && field !== document.body && scrollParent(field)) {
    field.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
}

// Mounted once, at the app root.
export function useKeyboardInsetTracker(): void {
  useEffect(() => {
    let nativeHeight = 0;
    let innerAtShow = 0;
    const vv = window.visualViewport;

    const recompute = () => {
      const layout = window.innerHeight;
      const native = nativeHeight > 0 ? keyboardOverlap(nativeHeight, innerAtShow, layout) : 0;
      // Pinch-zoom also shrinks the visualViewport; only a touch device at
      // 1x is the keyboard.
      const browser =
        vv && deviceKind() === 'touch' && Math.abs(vv.scale - 1) < 0.01
          ? Math.max(0, layout - vv.height)
          : 0;
      const covered = Math.max(native, browser);
      if (apply(covered, layout - covered)) {
        keyboardPanUntil = performance.now() + LATE_PAN_MS;
        settle();
      }
    };
    const onShow = (ev: Event) => {
      nativeHeight = readKeyboardHeight(ev);
      innerAtShow = window.innerHeight;
      recompute();
    };
    const onHide = () => {
      nativeHeight = 0;
      innerAtShow = 0;
      recompute();
    };
    // The keyboard's own pan can land after the keyboard reports in; undo
    // that one too. A pan after that is iOS keeping the caret in view while
    // typing: left alone.
    const onScroll = () => {
      if (inset > 0 && window.scrollY !== 0 && performance.now() < keyboardPanUntil) settle();
    };

    window.addEventListener('keyboardWillShow', onShow);
    window.addEventListener('keyboardDidShow', onShow);
    window.addEventListener('keyboardWillHide', onHide);
    window.addEventListener('keyboardDidHide', onHide);
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', onScroll);
    vv?.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('keyboardWillShow', onShow);
      window.removeEventListener('keyboardDidShow', onShow);
      window.removeEventListener('keyboardWillHide', onHide);
      window.removeEventListener('keyboardDidHide', onHide);
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', onScroll);
      vv?.removeEventListener('resize', recompute);
      keyboardPanUntil = 0;
      apply(0, window.innerHeight);
    };
  }, []);
}
