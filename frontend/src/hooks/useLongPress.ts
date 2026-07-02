import { useCallback, useEffect, useRef } from 'react';
import { triggerMessageActionHaptic } from '@/lib/haptics';

interface UseLongPressOptions {
  // Fired once the press is held past `delayMs` without moving. Runs a haptic
  // pulse first, mirroring the message action-sheet long-press.
  onLongPress: () => void;
  // When false the hook is inert — no timers, no listeners. Desktop passes
  // `enabled: isMobile === false` so the pointer plumbing never competes with
  // the native HTML5 drag used for sidebar reordering.
  enabled?: boolean;
  // Hold duration before the press counts as "long". MessageItem passes 420ms;
  // the row default is a touch longer so a deliberate press is required.
  delayMs?: number;
}

// A press that drifts more than this many px is treated as a scroll/drag, not a
// long-press, and cancels the pending timer.
const MOVE_CANCEL_THRESHOLD = 10;

// THE touch long-press implementation (sidebar rows via useRowLongPressMenu,
// the message action sheet in MessageItem — do not hand-roll another copy).
// Returns pointer handlers to spread onto the target element, plus
// `shouldSuppressClick()`, a one-shot getter the caller reads in the element's
// click handler to swallow the click that a touch release fires right after a
// long-press (so a long-press-to-open-menu doesn't also navigate), plus
// `cancel()` for callers that need to abort a pending press programmatically
// (e.g. closing the action sheet mid-press).
//
// Only touch/pen (pointerType !== 'mouse') arms the timer, window
// pointerup/pointercancel abort it, and movement past a small threshold
// cancels. When `enabled` is false every handler is a no-op, so the same row
// works unchanged with mouse + native drag.
export function useLongPress({ onLongPress, enabled = true, delayMs = 450 }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  // Keep the latest callback without re-creating the handlers each render.
  const onLongPressRef = useRef(onLongPress);
  useEffect(() => {
    onLongPressRef.current = onLongPress;
  }, [onLongPress]);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  // Clear any pending timer if the element unmounts mid-press.
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled || e.pointerType === 'mouse') return;
      cancel();
      // A fresh press clears a stale suppression so a suppressed-but-never-clicked
      // long-press can't poison the next real tap.
      suppressClickRef.current = false;
      startRef.current = { x: e.clientX, y: e.clientY };
      const abort = () => cancel();
      window.addEventListener('pointerup', abort, { once: true });
      window.addEventListener('pointercancel', abort, { once: true });
      timerRef.current = window.setTimeout(() => {
        suppressClickRef.current = true;
        triggerMessageActionHaptic();
        onLongPressRef.current();
        timerRef.current = null;
      }, delayMs);
    },
    [enabled, delayMs, cancel],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (timerRef.current === null || startRef.current === null) return;
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      if (Math.hypot(dx, dy) > MOVE_CANCEL_THRESHOLD) cancel();
    },
    [cancel],
  );

  // One-shot: true exactly once after a long-press fired, then resets so a
  // later short tap is never suppressed.
  const shouldSuppressClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
    },
    shouldSuppressClick,
    cancel,
  };
}
