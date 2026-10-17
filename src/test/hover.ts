import { vi } from 'vitest';
import { userEvent } from 'vitest/browser';

// parkMouse moves the browser's real mouse to the bottom-left corner of the
// viewport, away from anything a test renders. A real mouse left resting on a
// row (an earlier test clicked a row's menu there) hovers the row that renders
// under it next — Chromium replays the hover a frame after the layout changes
// — and rows hover one at a time, so that replayed hover took the hover, and
// the toolbar, from the row a test had just hovered.
export async function parkMouse() {
  const spot = document.createElement('div');
  spot.style.cssText = 'position:fixed;left:0;bottom:0;width:4px;height:4px;z-index:2147483647';
  document.body.appendChild(spot);
  try {
    await userEvent.hover(spot);
  } finally {
    spot.remove();
  }
}

// Hover a message row in the browser suite. Rows hover on a MOUSE pointer
// event — React derives onPointerEnter from pointerover — dispatched here
// rather than by moving the real mouse onto the row, after the real mouse is
// parked out of the way (see parkMouse). The toolbar the hover mounts is
// waited for: React renders it on a later task, which a loaded CI machine can
// take well over a fixed sleep to get to.
export async function hoverRow(row: Element | null) {
  if (!row) throw new Error('hoverRow: no row to hover');
  await parkMouse();
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
