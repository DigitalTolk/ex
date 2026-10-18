// A chat list resized from below — the phone's keyboard coming up or going
// (the app is sized to the space above it, hooks/useKeyboardInset), its
// composer opening the toolbar or growing a line — keeps what was at the
// bottom of its view at the bottom of its view, as in any chat app: the
// messages move up with the composer instead of sliding under it. Applied
// before the frame is painted, so nothing jumps. Returns the detach.
export function keepBottomEdge(scroller: HTMLElement): () => void {
  let viewHeight = scroller.clientHeight;
  const observer = new ResizeObserver(() => {
    const shrunk = viewHeight - scroller.clientHeight;
    viewHeight = scroller.clientHeight;
    // Taller at the end of the list: the browser has already held the end in
    // place (its scroll position can't stay past the new end).
    if (shrunk < 0 && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) return;
    if (shrunk) scroller.scrollTop += shrunk;
  });
  observer.observe(scroller);
  return () => observer.disconnect();
}
