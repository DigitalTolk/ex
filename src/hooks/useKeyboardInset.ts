import { useEffect, useSyncExternalStore } from 'react';
import { deviceKind } from '@/lib/device';
import { keyboardOverlap, readKeyboardHeight } from '@/lib/keyboard';
// How many px of the bottom of the screen the on-screen keyboard covers.
//
// iOS doesn't shrink the page for the keyboard: it PANS everything up so the
// focused field shows, which pushed the channel header (and the whole top of
// the app) off the screen. The app instead sizes its root to the space above
// the keyboard — `--ex-keyboard-inset` on <html> — and undoes any pan, so the
// header stays pinned to the top and the composer sits right on the keyboard.
//
// Two sources: the Capacitor shell reports the native keyboard height
// (WKWebView's visualViewport ignores the keyboard), and mobile Safari
// shrinks the visualViewport.

let inset = 0;
const listeners = new Set<() => void>();
let settlingTimer = 0;

function setInset(next: number) {
  const rounded = Math.max(0, Math.round(next));
  if (rounded === inset) return;
  inset = rounded;
  const root = document.documentElement;
  root.style.setProperty('--ex-keyboard-inset', `${inset}px`);
  // The app root glides to its new height only while the keyboard moves
  // (data-keyboard-settling, see index.css) — a window resize or the browser
  // toolbar collapsing must not animate the whole app. The glide's duration
  // comes from here, so the CSS transition and this timer can't drift apart.
  root.style.setProperty('--ex-keyboard-settle', `${KEYBOARD_SETTLE_MS}ms`);
  root.dataset.keyboardSettling = 'true';
  window.clearTimeout(settlingTimer);
  settlingTimer = window.setTimeout(() => delete root.dataset.keyboardSettling, KEYBOARD_SETTLE_MS);
  for (const l of listeners) l();
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

// How long the app's root takes to follow the keyboard — about the length
// of the iOS keyboard's own slide, so the two move together.
export const KEYBOARD_SETTLE_MS = 250;

// While true the app is gliding to its keyboard-up (or -down) size; scroll
// events from that glide are ours, not iOS panning again.
let settling = false;

// iOS reveals a focused field by panning the whole page up. Instead of
// snapping it back (a visible jump), glide the page back to the top while the
// root shrinks over the same time, then glide the field into view inside its
// own scroller (a login form, a dialog) if the keyboard still covers it. The
// chat composer sits at the bottom of the root, so it simply rides up.
function settle() {
  settling = true;
  if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
  window.setTimeout(() => {
    settling = false;
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' });
    const field = document.activeElement;
    if (inset > 0 && field instanceof HTMLElement && field !== document.body && scrollParent(field)) {
      field.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, KEYBOARD_SETTLE_MS + 30);
}

// Mounted once, at the app root.
export function useKeyboardInsetTracker(): void {
  useEffect(() => {
    let nativeHeight = 0;
    let innerAtShow = 0;
    const vv = window.visualViewport;

    const recompute = () => {
      const native = nativeHeight > 0 ? keyboardOverlap(nativeHeight, innerAtShow, window.innerHeight) : 0;
      // Pinch-zoom also shrinks the visualViewport; only a touch device at
      // 1x is the keyboard.
      const browser =
        vv && deviceKind() === 'touch' && Math.abs(vv.scale - 1) < 0.01
          ? Math.max(0, window.innerHeight - vv.height)
          : 0;
      const before = inset;
      setInset(Math.max(native, browser));
      if (inset !== before) settle();
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
    // The pan can land after the keyboard reports in; keep the page at the top.
    const onScroll = () => {
      if (inset > 0 && !settling && window.scrollY !== 0) settle();
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
      setInset(0);
    };
  }, []);
}
