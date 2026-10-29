import { useEffect, useRef, type RefObject } from 'react';

// 120px slack so a tiny accidental scroll up doesn't flip the user
// out of "at bottom" mode (and accidental swipes don't either).
const AT_BOTTOM_THRESHOLD_PX = 120;

// useAtBottomRef returns a ref whose `.current` is true while the user
// follows the bottom of the given scroll container, so callers can read
// it synchronously when deciding whether to follow new content down.
//
// Only the reader leaves the bottom: an upward scroll that ends more than
// the slack away. Not every scroll event is theirs — when content grows at
// the bottom the browser's scroll anchoring moves the view down a little,
// and that event arrives before the ResizeObserver that would follow the
// growth; read as a position it said "not at bottom" and the newest reply
// (an image that had just loaded) was left below the fold. Coming back
// within the slack, by any scroll, rejoins the bottom.
//
// Initialized to `true` so the very first commit (before the user has
// had a chance to scroll) treats the user as "at bottom" — matching
// the typical chat UX where new arrivals follow you on first paint.
//
// `onChange` hears each change. Callers set the ref themselves too (when they
// follow new content down), so a change is judged against the last one
// reported, not against the ref. A new `resetKey` starts the reports over:
// a panel that stays mounted while it switches threads reports the new
// thread's position, not a change from the old one's.
export function useAtBottomRef(
  scrollRef: RefObject<HTMLElement | null>,
  onChange?: (atBottom: boolean) => void,
  resetKey?: string,
): RefObject<boolean> {
  const atBottomRef = useRef(true);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    let reported = true;
    const set = (atBottom: boolean) => {
      atBottomRef.current = atBottom;
      if (atBottom === reported) return;
      reported = atBottom;
      onChangeRef.current?.(atBottom);
    };
    set(distance() < AT_BOTTOM_THRESHOLD_PX);
    let lastTop = el.scrollTop;
    const update = () => {
      const top = el.scrollTop;
      if (distance() < AT_BOTTOM_THRESHOLD_PX) set(true);
      else if (top < lastTop) set(false);
      lastTop = top;
    };
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [scrollRef, resetKey]);
  return atBottomRef;
}
