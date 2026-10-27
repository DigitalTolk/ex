import { afterEach, describe, expect, it } from 'vitest';
import { keepInView } from './keep-in-view';

// keepInView on a plain scroller: a box near the bottom of the view grows
// open below its first line, or the view shrinks under it.

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.replaceChildren();
});

function setup() {
  const scroller = document.createElement('div');
  scroller.style.cssText = 'height:300px;overflow-y:auto';
  const above = document.createElement('div');
  above.style.height = '1000px';
  const box = document.createElement('div');
  box.style.height = '40px';
  const below = document.createElement('div');
  below.style.height = '1000px';
  scroller.append(above, box, below);
  document.body.appendChild(scroller);
  // The box shows, right at the bottom of the view.
  scroller.scrollTop = 1040 - 300;
  const edges = () => {
    const b = box.getBoundingClientRect();
    const v = scroller.getBoundingClientRect();
    return { top: Math.round(b.top - v.top), bottom: Math.round(v.bottom - b.bottom) };
  };
  return { scroller, box, edges };
}

describe('keepInView', () => {
  it('leaves a box that shows where it is', async () => {
    const { scroller, box } = setup();
    cleanup = keepInView(box);
    await frame();
    await frame();
    expect(scroller.scrollTop).toBe(740);
  });

  it('scrolls a box that grows open below the view back into it', async () => {
    const { box, edges } = setup();
    cleanup = keepInView(box);
    await frame();
    box.style.height = '120px';
    await frame();
    await frame();
    expect(edges()).toEqual({ top: 180, bottom: 0 });
  });

  it('scrolls the box above a view that shrinks under it', async () => {
    const { scroller, box, edges } = setup();
    cleanup = keepInView(box);
    await frame();
    scroller.style.height = '200px';
    await frame();
    await frame();
    expect(edges()).toEqual({ top: 160, bottom: 0 });
  });

  it('keeps the top of a box taller than the view in view', async () => {
    const { box, edges } = setup();
    cleanup = keepInView(box);
    await frame();
    box.style.height = '500px';
    await frame();
    await frame();
    expect(edges().top).toBe(0);
  });

  it('does nothing for a box no scroller holds', async () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    cleanup = keepInView(box);
    box.style.height = '120px';
    await frame();
    expect(box.getBoundingClientRect().height).toBe(120);
  });

  it('stops following once cleaned up', async () => {
    const { scroller, box } = setup();
    keepInView(box)();
    await frame();
    box.style.height = '120px';
    await frame();
    await frame();
    expect(scroller.scrollTop).toBe(740);
  });
});
