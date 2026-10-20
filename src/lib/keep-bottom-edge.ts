// keepBottomEdge holds what sits at the bottom of a scroller in place when the
// scroller itself changes height — the on-screen keyboard coming up or going
// down, the message box growing or shrinking under it — so the newest
// messages a reader was looking at stay right above the box, whether or not
// they were at the very end. Returns the cleanup.
export function keepBottomEdge(scroller: HTMLElement): () => void {
  let viewHeight = scroller.clientHeight;
  // How far the view stood from the end of the content, as last seen.
  let fromEnd = 0;
  const note = () => {
    fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  };
  note();
  const observer = new ResizeObserver(() => {
    const shrunk = viewHeight - scroller.clientHeight;
    viewHeight = scroller.clientHeight;
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (shrunk > 0 || scroller.scrollTop < end - 1) {
      scroller.scrollTop += shrunk;
    } else if (shrunk < 0) {
      // Taller, and at the end: a view that can't stand past the content has
      // been moved up to it already. Back to where it stood — unchanged for a
      // reader who was at the end.
      scroller.scrollTop = end - fromEnd;
    }
    note();
  });
  observer.observe(scroller);
  scroller.addEventListener('scroll', note, { passive: true });
  return () => {
    observer.disconnect();
    scroller.removeEventListener('scroll', note);
  };
}
