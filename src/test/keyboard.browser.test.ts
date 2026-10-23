import { afterEach, describe, expect, it } from 'vitest';
import { keyboardSettled } from './keyboard';

// keyboardSettled waits for the page, never for the clock.
describe('keyboardSettled', () => {
  let box: HTMLElement;
  const bottom = () => window.innerHeight - Math.round(box.getBoundingClientRect().bottom);

  afterEach(() => {
    box.remove();
  });

  function slidingBox() {
    box = document.createElement('div');
    box.style.cssText = 'position: fixed; left: 0; bottom: 0; width: 10px; height: 10px; transition: bottom 250ms ease-out';
    document.body.append(box);
    expect(bottom()).toBe(0);
    box.style.bottom = '300px';
  }

  // A slide starts when the browser next renders. A long task before that (a
  // busy runner) puts it off, and a fixed wait measured the slide halfway.
  it('waits for a slide that starts late', async () => {
    slidingBox();
    queueMicrotask(() => {
      const start = performance.now();
      while (performance.now() - start < 300);
    });
    await keyboardSettled(() => true);
    expect(bottom()).toBe(300);
  });

  it('is not held up by an endless animation', async () => {
    slidingBox();
    const pulse = box.animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 1000, iterations: Infinity });
    try {
      await keyboardSettled(() => bottom() === 300);
      expect(pulse.playState).toBe('running');
    } finally {
      pulse.cancel();
    }
  });
});
