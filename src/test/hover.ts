import { vi } from 'vitest';

// Hover a message row in the browser suite without moving the browser's one
// real mouse (other files run in parallel and a real pointer crossing their
// rows makes hover-only checks flake). Rows hover on a MOUSE pointer event —
// React derives onPointerEnter from pointerover — and the toolbar the hover
// mounts is waited for: React renders it on a later task, which a loaded CI
// machine can take well over a fixed sleep to get to.
export async function hoverRow(row: Element | null) {
  if (!row) throw new Error('hoverRow: no row to hover');
  row.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
  row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  await vi.waitFor(
    () => {
      if (!row.querySelector('[role="toolbar"][aria-label="Message actions"]')) {
        throw new Error('hoverRow: the row\'s toolbar did not mount');
      }
    },
    { timeout: 5000, interval: 20 },
  );
}
