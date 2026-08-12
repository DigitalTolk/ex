// Text-overlap detector for the browser suite: finds pairs of TEXT-bearing
// elements whose rendered boxes intersect — "text on top of each other".
//
// Class assertions can't see this bug: every class can be present and correct
// while the resolved geometry stacks two labels. Only the layout engine's
// answer (getBoundingClientRect) shows it, so this must run in a real
// browser project, never jsdom.

interface TextBox {
  el: Element;
  rect: DOMRect;
  text: string;
}

export interface OverlapPair {
  a: string;
  b: string;
  horizontal: number;
  vertical: number;
}

function label(box: TextBox): string {
  const el = box.el as HTMLElement;
  const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? '';
  return `<${el.tagName.toLowerCase()}${id ? ` ${id}` : ''}> "${box.text.slice(0, 40)}"`;
}

// Direct text only: an element counts when it has a non-whitespace text NODE
// child (not text inherited from descendants), so ancestor/descendant pairs
// never self-report.
function hasDirectText(el: Element): boolean {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

function visible(el: Element): boolean {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// getBoundingClientRect ignores clipping, so a tile scrolled below the fold
// of an overflow:auto body "intersects" whatever sits under the scroller —
// visually a lie. Clamp each box to every scroll-clipping ancestor; a box
// clipped to nothing is invisible and drops out.
function clampToClips(el: Element, rect: DOMRect, root: Element): DOMRect | null {
  let top = rect.top;
  let left = rect.left;
  let bottom = rect.bottom;
  let right = rect.right;
  for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const clipsY = cs.overflowY !== 'visible';
    const clipsX = cs.overflowX !== 'visible';
    if (!clipsY && !clipsX) continue;
    const pr = p.getBoundingClientRect();
    if (clipsY) {
      top = Math.max(top, pr.top);
      bottom = Math.min(bottom, pr.bottom);
    }
    if (clipsX) {
      left = Math.max(left, pr.left);
      right = Math.min(right, pr.right);
    }
    if (bottom <= top || right <= left) return null;
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * Report every pair of visible text-bearing elements under `root` whose boxes
 * overlap by more than `tolerancePx` in BOTH axes. The tolerance absorbs
 * intentional near-touches (negative letter-spacing, borders); real stacking
 * overlaps by many pixels.
 */
export function findTextOverlaps(root: Element, tolerancePx = 2): OverlapPair[] {
  const boxes: TextBox[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.currentNode as Element | null; el; el = walker.nextNode() as Element | null) {
    if (!hasDirectText(el) || !visible(el)) continue;
    const rect = clampToClips(el, el.getBoundingClientRect(), root);
    if (!rect) continue;
    boxes.push({ el, rect, text: (el.textContent ?? '').trim() });
  }
  const out: OverlapPair[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i];
      const B = boxes[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const h = Math.min(A.rect.right, B.rect.right) - Math.max(A.rect.left, B.rect.left);
      const v = Math.min(A.rect.bottom, B.rect.bottom) - Math.max(A.rect.top, B.rect.top);
      if (h > tolerancePx && v > tolerancePx) {
        out.push({ a: label(A), b: label(B), horizontal: Math.round(h), vertical: Math.round(v) });
      }
    }
  }
  return out;
}
