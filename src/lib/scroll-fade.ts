// The soft fade-and-blur a sidebar list gets where it scrolls under fixed
// chrome: the Home / Activity header above it, the account strip below. One
// place, so every edge fades alike. Callers position it (top-0, top-full,
// bottom-full …); it never takes clicks.
const BASE =
  'pointer-events-none absolute inset-x-0 z-10 h-8 from-sidebar to-transparent backdrop-blur-[2px] transition-opacity duration-200';

// Whether a scroll event's scroller has moved off its top — the top fade
// shows only then, so a list at rest isn't veiled. Pass it as an
// onScrollCapture handler's result (scroll events don't bubble; capture does).
export function scrolledOffTop(e: { target: EventTarget }): boolean {
  return e.target instanceof HTMLElement && e.target.scrollTop > 0;
}

// Over the top of a list: solid at the top, clear further down.
export const SCROLL_FADE_TOP = `${BASE} bg-gradient-to-b [mask-image:linear-gradient(to_bottom,black,transparent)]`;

// Over the bottom of a list: solid at the bottom, clear further up.
export const SCROLL_FADE_BOTTOM = `${BASE} bg-gradient-to-t [mask-image:linear-gradient(to_top,black,transparent)]`;
