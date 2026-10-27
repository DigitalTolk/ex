// keepInView keeps all of `el` inside the scroller it sits in while either of
// them changes size: the on-screen keyboard shrinking the view, the box
// growing open below the line being typed on. It scrolls that scroller, never
// the page, by just enough, and leaves a box that already shows alone.
// Returns the cleanup.
export function keepInView(el: HTMLElement): () => void {
  const scroller = scrollerOf(el);
  if (!scroller) return () => undefined;
  const observer = new ResizeObserver(() => {
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    // Down by what hangs below the view, as far as the top allows: a box
    // taller than the view keeps its top in it.
    const by = Math.min(box.bottom - view.bottom, box.top - view.top);
    if (by > 0) scroller.scrollTop += by;
  });
  observer.observe(el);
  observer.observe(scroller);
  return () => observer.disconnect();
}

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}
