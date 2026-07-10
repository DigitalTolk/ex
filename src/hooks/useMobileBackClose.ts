import { useEffect } from 'react';
import { useIsMobile } from './useIsMobile';
import { useLatestRef } from './useLatestRef';

// history.state key marking an overlay-close sentinel entry (see hook doc).
const OVERLAY_MARKER = '__exOverlayBackClose';
// Monotonic id so stacked overlays (a dialog over the drawer) can tell whose
// sentinel a popstate landed on — consuming an inner sentinel must not close
// the outer overlay.
let overlaySequence = 0;
// Queued sentinel-consume traversals: UI-closing an overlay calls
// history.back() to eat its sentinel, but that traversal is ASYNC. If another
// overlay arms before it lands, the traversal would pop the NEW sentinel and
// spuriously close the new overlay. The module-level popstate listener below
// (registered before any per-hook listener, so it runs first) stamps each
// consume pop on the EVENT OBJECT so armed hooks can tell it from a user
// Back. (A time-based flag doesn't work: the browser runs a microtask
// checkpoint between listeners of a native event, so anything deferred can
// reset before the per-hook listeners run.)
let pendingConsumes = 0;
const consumedPops = new WeakSet<Event>();

/* v8 ignore next -- browser-only app: window always exists; the guard is for module import under SSR-style tooling */
/* istanbul ignore next -- browser-only app: window always exists; the guard is for module import under SSR-style tooling */
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    if (pendingConsumes > 0) {
      pendingConsumes -= 1;
      consumedPops.add(e);
    }
  });
}

// Test-only: clears the module bookkeeping so one test's queued consume
// (whose traversal a jsdom spy swallowed) can't leak into the next.
export function resetMobileBackCloseForTests(): void {
  pendingConsumes = 0;
}

function pushSentinel(id: number): void {
  const baseState = window.history.state;
  // Spread the router's own entry state (React Router keeps {usr,key,idx}
  // there) so traversal bookkeeping survives the sentinel.
  window.history.pushState(
    { ...(typeof baseState === 'object' && baseState !== null ? baseState : {}), [OVERLAY_MARKER]: id },
    '',
  );
}

/**
 * useMobileBackClose makes the hardware/browser Back button close an open
 * overlay (dialog, sheet, panel, drawer) on mobile instead of navigating away
 * — in a Capacitor Android shell the default Back handler pops SPA history or
 * EXITS the app, so without this every open overlay was one reflexive Back
 * press away from losing the page (or the whole app).
 *
 * While `open` (on a mobile viewport, with a close handler), it pushes a
 * same-URL history sentinel; the next Back pops the sentinel and the hook
 * calls `onClose`. Closing the overlay through its own UI instead consumes
 * the sentinel (one history.back()) so Back never needs a dead extra press —
 * unless a real navigation already replaced the top entry, in which case
 * history is left alone.
 */
export function useMobileBackClose(open: boolean, onClose: (() => void) | undefined) {
  const isMobile = useIsMobile();
  const onCloseRef = useLatestRef(onClose);
  useEffect(() => {
    if (!open || !isMobile || !onCloseRef.current) return;
    overlaySequence += 1;
    const id = overlaySequence;
    pushSentinel(id);
    const onPop = (e: PopStateEvent) => {
      const state = window.history.state as Record<string, unknown> | null;
      const marker = state?.[OVERLAY_MARKER];
      // Landed on / above our own sentinel: a STACKED overlay consumed its
      // inner sentinel and history settled back onto ours — not a Back
      // through this overlay.
      const atOrAboveOwnSentinel = typeof marker === 'number' && marker >= id;
      if (consumedPops.has(e)) {
        // A queued UI-close consume traversal from an ALREADY-CLOSED overlay,
        // not a user Back. If it also ate OUR sentinel (we armed between the
        // close and its traversal landing), restore it; never close for it.
        if (!atOrAboveOwnSentinel) pushSentinel(id);
        return;
      }
      if (atOrAboveOwnSentinel) return;
      onCloseRef.current?.();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      const state = window.history.state as Record<string, unknown> | null;
      if (state?.[OVERLAY_MARKER] === id) {
        pendingConsumes += 1;
        window.history.back();
      }
    };
  }, [open, isMobile, onCloseRef]);
}
