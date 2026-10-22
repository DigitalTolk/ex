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
