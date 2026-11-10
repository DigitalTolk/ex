import { useEffect, useRef, useState, type RefObject } from 'react';

interface UseInViewOptions {
  // Margin around the root that expands the "in view" area. Defaults to
  // a generous "200px" so cards begin loading just before they scroll
  // into view, which feels instant on slow networks.
  rootMargin?: string;
}

// useInView returns a ref to attach to an element and a boolean that
// flips true once the element enters the viewport. The flag is sticky —
// once true, it stays true even if the element scrolls back out — so
// downstream queries don't re-fetch on every visibility change.
//
// Falls back to instantly-true when IntersectionObserver isn't
// available (older test envs, jsdom without polyfill) so behavior in
// those environments matches the no-virtualization baseline.
export function useInView<T extends HTMLElement>({ rootMargin = '200px' }: UseInViewOptions = {}) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(
    typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}

// useLiveInView tracks CURRENT viewport intersection of an existing ref —
// non-sticky, unlike useInView: it flips back to false when the element
// scrolls out. Used for "is the user reading this right now" registration
// (thread-scope), where a sticky flag would keep suppressing notifications
// for a card merely scrolled past. No rootMargin: only genuine visibility
// counts. Falls back to true when IntersectionObserver is unavailable
// (jsdom), matching useInView's no-virtualization baseline.
export function useLiveInView<T extends HTMLElement>(ref: RefObject<T | null>): boolean {
  const [live, setLive] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        setLive(entry.isIntersecting);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return live;
}
