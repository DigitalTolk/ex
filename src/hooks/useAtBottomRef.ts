import { useEffect, useRef, type RefObject } from 'react';

// 120px slack so a tiny accidental scroll up doesn't flip the user
// out of "at bottom" mode (and accidental swipes don't either).
const AT_BOTTOM_THRESHOLD_PX = 120;

// useAtBottomRef returns a ref whose `.current` is true while the user
// is within ~120px of the bottom of the given scroll container. The
// value is updated on every scroll event so callers can read it
// synchronously when deciding whether to follow new content down.
//
// Initialized to `true` so the very first commit (before the user has
// had a chance to scroll) treats the user as "at bottom" — matching
// the typical chat UX where new arrivals follow you on first paint.
export function useAtBottomRef(
  scrollRef: RefObject<HTMLElement | null>,
): RefObject<boolean> {
  const atBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      atBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [scrollRef]);
  return atBottomRef;
}
