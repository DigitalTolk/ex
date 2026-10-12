// While a chat list scrolls, the rows passing under a still pointer each get
// a mouseenter, and each one mounts its hover toolbar (three pickers, a menu)
// and tears it down a frame later. On a fast wheel that is a mount per row per
// frame, and the frame rate goes with it. Browsers settle hover only after
// the scroll stops, so the trick is to stop the rows being hit-testable while
// the scroll is in flight: `data-scrolling` on the scroller turns off pointer
// events on the rows (see index.css), no row sees the pointer, and when the
// flag drops the browser re-runs its hit test and the row under the pointer
// gets its mouseenter then, as if the reader had just arrived. Slack does the
// same. Wheel and touch still reach the scroller through the rows.

export const SCROLL_HOVER_PAUSE_MS = 150;

export function attachScrollHoverPause(scroller: HTMLElement): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    timer = null;
    delete scroller.dataset.scrolling;
  };
  const onScroll = () => {
    // Set once per burst: writing the attribute on every scroll event would
    // invalidate style for the whole list each time.
    if (timer === null) scroller.dataset.scrolling = 'true';
    else clearTimeout(timer);
    timer = setTimeout(settle, SCROLL_HOVER_PAUSE_MS);
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    scroller.removeEventListener('scroll', onScroll);
    if (timer !== null) {
      clearTimeout(timer);
      settle();
    }
  };
}
