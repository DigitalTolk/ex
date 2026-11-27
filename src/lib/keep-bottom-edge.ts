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
  // Whether the reader is at the end. Content growing under a reader there (a
  // picture loading, a message arriving) leaves them there, however far the
  // view stands from the new end until the list catches up: going by the
  // distance alone, a catch-up taken for the browser pulling the view back
  // put a reader whose sent picture had just loaded 61px above the end.
  let atEnd = false;
  let contentHeight = 0;
  const note = () => {
    const grew = scroller.scrollHeight > contentHeight;
    contentHeight = scroller.scrollHeight;
    top = scroller.scrollTop;
    fromEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    scrollable = scroller.scrollHeight > scroller.clientHeight;
    // An empty or short list is at the end of nothing: one that fills later
    // leaves its reader where they are.
    atEnd = (scrollable && fromEnd <= 1) || (atEnd && grew);
  };
  note();
  // The browser pulled the view back inside the content since the observer
  // last ran (see onScroll).
  let pulled = false;
  const observer = new ResizeObserver(() => {
    const shrunk = viewHeight - scroller.clientHeight;
    viewHeight = scroller.clientHeight;
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (shrunk !== 0) {
      // Moved since last seen, and not by the browser pulling a view that no
      // longer fits back to the end: a scroll whose event is still to come
      // (the list jumping to the newest message in this frame). Go by where
      // it is. A pull can hide behind a net change the other way: a view that
      // grew and shrank again before this ran (the keyboard coming up: the
      // composer drops its home-indicator padding, then opens its toolbar).
      if (!pulled && scroller.scrollTop !== top && top <= end) note();
      if (atEnd) {
        scroller.scrollTop = end;
      } else if (shrunk > 0 || scroller.scrollTop < end - 1) {
        scroller.scrollTop += shrunk;
      } else {
        // Taller, and at the end: a view that can't stand past the content
        // has been moved up to it already. Back to where it stood.
        scroller.scrollTop = end - fromEnd;
      }
    }
    pulled = false;
    note();
  });
  observer.observe(scroller);
  // A scroll while the view has a height the observer has yet to hear of is
  // the browser pulling a taller view back inside the content, not the
  // reader: it can come first when the new height was laid out from another
  // ResizeObserver (a virtualized list measuring its rows), which puts this
  // one off to the next frame. The observer goes by where the view stood.
  const onScroll = () => {
    if (scroller.clientHeight === viewHeight) note();
    else pulled = true;
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    observer.disconnect();
    scroller.removeEventListener('scroll', onScroll);
  };
}
