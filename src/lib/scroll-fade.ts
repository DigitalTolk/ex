// The soft fade a sidebar list gets where it scrolls under fixed chrome: the
// Home / Activity header above it, the account strip below. One place, so
// every edge fades alike. Callers position it (top-0, top-full, bottom-full
// …); it never takes clicks. A gradient only, no backdrop blur: a blur is a
// GPU layer of its own, re-sampled on every frame of a scroll, and they are
// what crashed long chats on phones (src/test/compositing-budget).
const BASE =
  'pointer-events-none absolute inset-x-0 z-10 h-8 from-sidebar to-transparent transition-opacity duration-200';

// An onScrollCapture handler reporting whether the list has moved off its
// top — the top fade shows only then, so a list at rest isn't veiled. Scroll
// events don't bubble, but capture sees every scroller inside the list's
// wrapper: only one that scrolls vertically counts, so a row of tabs scrolled
// sideways can't switch the fade off.
export function trackScrolledOffTop(set: (scrolled: boolean) => void) {
  return (e: { target: EventTarget }) => {
    const el = e.target as HTMLElement;
    if (el.scrollHeight <= el.clientHeight) return;
    set(el.scrollTop > 0);
  };
}

// Over the top of a list: solid at the top, clear further down.
export const SCROLL_FADE_TOP = `${BASE} bg-gradient-to-b [mask-image:linear-gradient(to_bottom,black,transparent)]`;

// Over the bottom of a list: solid at the bottom, clear further up.
export const SCROLL_FADE_BOTTOM = `${BASE} bg-gradient-to-t [mask-image:linear-gradient(to_top,black,transparent)]`;
