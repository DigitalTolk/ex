import { afterEach, describe, expect, it } from 'vitest';
import { keepBottomEdge } from './keep-bottom-edge';

// keepBottomEdge on a plain scroller: the message box under a chat closing
// (the scroller growing over a few frames) while the newest message arrives
// and the list jumps to it.

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.replaceChildren();
});

function setup(height = 300) {
  const scroller = document.createElement('div');
  scroller.style.cssText = `height:${height}px;overflow-y:auto`;
  const content = document.createElement('div');
  content.style.height = '1000px';
  scroller.appendChild(content);
  document.body.appendChild(scroller);
  scroller.scrollTop = scroller.scrollHeight;
  cleanup = keepBottomEdge(scroller);
  const fromEnd = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const grow = (px: number) => {
    height += px;
    scroller.style.height = `${height}px`;
  };
  const addMessage = (px: number) => {
    const row = document.createElement('div');
    row.style.height = `${px}px`;
    scroller.appendChild(row);
  };
  return { scroller, fromEnd, grow, addMessage };
}

describe('keepBottomEdge', () => {
  it('keeps a reader at the end there when a message arrives as the box closes', async () => {
    const { fromEnd, grow, addMessage } = setup();
    await frame();
    addMessage(50);
    grow(4);
    await frame();
    await frame();
    expect(fromEnd()).toBeLessThanOrEqual(1);
  });

  // The list jumps to the newest message in an animation frame, and the box
  // goes on closing in that same frame — before the jump's scroll event.
  it('lets a jump to the end stand while the box goes on closing', async () => {
    const { scroller, fromEnd, grow, addMessage } = setup();
    scroller.scrollTop -= 200;
    await frame();
    addMessage(50);
    await frame();
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => {
          scroller.scrollTop = scroller.scrollHeight;
          grow(4);
          resolve();
        }),
      );
    }
    await frame();
    await frame();
    expect(fromEnd()).toBeLessThanOrEqual(1);
  });

  // A sent image's row grows when its picture loads while the box is still
  // closing, and the browser nudges the view, so a scroll lands with the view
  // short of the new end. The list then catches up to the end in the same
  // frame the box closes a step further. That catch-up was taken for the
  // browser pulling the view back, and the reader was put back where the
  // nudge had left them (seen in CI as a sent image left 61px under the
  // fold). A reader at the end whose content grew is still at the end.
  it('keeps a reader at the end there when their content grows mid-closing', async () => {
    const { scroller, fromEnd, grow, addMessage } = setup();
    // The list measures its rows in a ResizeObserver of its own, and the box
    // closes a step from in there, so this helper hears of it a frame late.
    const row = document.createElement('div');
    row.style.height = '1px';
    scroller.appendChild(row);
    let catchUp = false;
    const list = new ResizeObserver(() => {
      if (!catchUp) return;
      catchUp = false;
      scroller.scrollTop = scroller.scrollHeight;
      grow(8);
    });
    list.observe(row);
    await frame();
    await frame();
    addMessage(160);
    scroller.scrollTop -= 40;
    await new Promise<void>((resolve) => scroller.addEventListener('scroll', () => resolve(), { once: true }));
    catchUp = true;
    row.style.height = '2px';
    for (let i = 0; i < 4; i += 1) await frame();
    list.disconnect();
    expect(fromEnd()).toBeLessThanOrEqual(1);
  });

  it('keeps a reader further up where they were as the box closes', async () => {
    const { scroller, fromEnd, grow } = setup();
    scroller.scrollTop -= 200;
    await frame();
    for (let i = 0; i < 4; i += 1) {
      grow(4);
      await frame();
    }
    await frame();
    expect(Math.round(fromEnd())).toBe(200);
  });

  // A taller view than the content below it: the browser pulls the view
  // down to the end first; it goes back to where it was.
  it('puts a reader a little way up back where they were when the view grows past them', async () => {
    const { scroller, fromEnd, grow } = setup();
    scroller.scrollTop -= 40;
    await frame();
    grow(300);
    await frame();
    await frame();
    expect(Math.round(fromEnd())).toBe(40);
  });

  // A virtualized list measures its rows in a ResizeObserver and lays out
  // again from there, the view's new height included: the browser pulls the
  // view back inside the content then, and an observer of the view itself
  // (shallower than the rows) hears of the new size only on the next frame —
  // after that scroll event, which is not the reader scrolling.
  it('puts a reader a little way up back where they were when the scroll comes before the resize is observed', async () => {
    const { scroller, fromEnd, grow } = setup();
    scroller.scrollTop -= 12;
    await frame();
    const rows = new ResizeObserver(() => {
      rows.disconnect();
      grow(300);
    });
    rows.observe(scroller.firstElementChild!);
    for (let i = 0; i < 4; i += 1) await frame();
    expect(Math.round(fromEnd())).toBe(12);
  });

  // Regression: the keyboard coming up on a phone. The composer drops its
  // home-indicator padding (the view grows, and the browser pulls a view at
  // the end up by as much; that scroll event comes in the next frame) and in
  // that next frame, before layout, starts opening its toolbar (the view
  // shrinks past where it was). The observer hears of the net change only,
  // took the browser's pull for the reader scrolling up, and left the newest
  // message under the composer.
  it('keeps a reader at the end there when the view grows and shrinks again within a frame', async () => {
    const { scroller, fromEnd, grow } = setup();
    await frame();
    // Between frames, as an input event's task would.
    await new Promise((resolve) => setTimeout(resolve, 0));
    grow(36);
    // The pull lands now; its scroll event comes before the next frame's callbacks.
    void scroller.scrollTop;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        grow(-43);
        resolve();
      }),
    );
    await frame();
    await frame();
    expect(fromEnd()).toBeLessThanOrEqual(1);
  });

  // Regression: sending an image on a phone. The list follows the new
  // message down while the message box closes under it, so the list's own
  // move down comes as a scroll event while the view is taller than the
  // observer has heard of. That read as the browser pulling the view back
  // inside its content (which only ever moves it up), so the list's jump to
  // the end in the next callback was undone to where it had stood before.
  it('lets a jump to the end stand when the list moved down as the box closed', async () => {
    const { scroller, fromEnd, grow } = setup();
    scroller.scrollTop -= 61;
    await frame();
    await frame();
    // Between frames: the box closes a step and the list starts down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    grow(16);
    scroller.scrollTop += 3;
    // That scroll event comes before the next frame's callbacks; the list
    // jumps to the end in one of them.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight;
        resolve();
      }),
    );
    await frame();
    await frame();
    expect(fromEnd()).toBeLessThanOrEqual(1);
  });

  it('keeps the bottom edge when the view shrinks', async () => {
    const { scroller, fromEnd, grow } = setup();
    scroller.scrollTop -= 100;
    await frame();
    grow(-120);
    await frame();
    await frame();
    expect(Math.round(fromEnd())).toBe(100);
  });

  // A thread opened at a linked reply near its top: the list is empty when
  // this attaches, fills without a scroll, and the view then changes size.
  // The reader stays where they are; an empty list was never "at the end".
  it('leaves a reader at the top of a list that filled after it attached', async () => {
    const scroller = document.createElement('div');
    scroller.style.cssText = 'height:300px;overflow-y:auto';
    document.body.appendChild(scroller);
    cleanup = keepBottomEdge(scroller);
    await frame();
    const content = document.createElement('div');
    content.style.height = '1000px';
    scroller.appendChild(content);
    await frame();
    await frame();
    expect(scroller.scrollTop).toBe(0);
    scroller.style.height = '296px';
    await frame();
    await frame();
    expect(scroller.scrollTop).toBeLessThanOrEqual(4);
  });
});
