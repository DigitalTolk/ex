// Hover a message row in the browser suite without moving the browser's one
// real mouse (other files run in parallel and a real pointer crossing their
// rows makes hover-only checks flake). Rows hover on a MOUSE pointer event —
// React derives onPointerEnter from pointerover — and a tick lets the hover
// state flush.
export async function hoverRow(row: Element | null) {
  row?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
  row?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  await new Promise((r) => setTimeout(r, 20));
}
