// keepBottomEdge holds what sits at the bottom of a scroller in place when the
// scroller itself changes height — the on-screen keyboard coming up or going
// down, the message box growing or shrinking under it — so the newest
// messages a reader was looking at stay right above the box, whether or not
// they were at the very end. A reader at the end stays at the end, a message
// that arrives meanwhile included. Returns the cleanup.
export function keepBottomEdge(scroller: HTMLElement): () => void {
  let viewHeight = scroller.clientHeight;
  // Where the view stood, as last seen: its offset, how far it was from the
  // end of the content, and whether there was anything to scroll (an empty
  // or short list is trivially "at the end" of nothing).
  let top = 0;
  let fromEnd = 0;
  let scrollable = false;
  const note = () => {
    top = scroller.scrollTop;
    fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    scrollable = scroller.scrollHeight > scroller.clientHeight;
  };
  note();
  const observer = new ResizeObserver(() => {
    const shrunk = viewHeight - scroller.clientHeight;
    viewHeight = scroller.clientHeight;
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (shrunk !== 0) {
      // Moved since last seen, and not by the browser pulling a view that no
      // longer fits back to the end: a scroll whose event is still to come
      // (the list jumping to the newest message in this frame). Go by where
      // it is.
      if (scroller.scrollTop !== top && top <= end) note();
      if (scrollable && fromEnd <= 1) {
        scroller.scrollTop = end;
      } else if (shrunk > 0 || scroller.scrollTop < end - 1) {
        scroller.scrollTop += shrunk;
      } else {
        // Taller, and at the end: a view that can't stand past the content
        // has been moved up to it already. Back to where it stood.
        scroller.scrollTop = end - fromEnd;
      }
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
