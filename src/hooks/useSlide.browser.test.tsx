import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useEffect, useRef } from 'react';
import { createSlide, useSlide, type Slide } from './useSlide';

// A slide runs as a Web Animation of the element's transform — which the
// browser plays on its compositor, so the page rendering under it can't
// stall it — and a finger can still catch it anywhere on its way.

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function box() {
  const el = document.createElement('div');
  el.style.cssText = 'width: 100px; height: 100px;';
  document.body.appendChild(el);
  return el;
}

const shownAt = (el: HTMLElement) => new DOMMatrix(getComputedStyle(el).transform).m41;

async function landsAt(el: HTMLElement, x: number) {
  const deadline = performance.now() + 5000;
  while (el.getAnimations().length > 0 && performance.now() < deadline) await raf();
  expect(el.getAnimations()).toHaveLength(0);
  expect(shownAt(el)).toBeCloseTo(x, 0);
}

function slideOf(el: HTMLElement, initial = 0) {
  const slide = createSlide(initial);
  slide.attach(el);
  return slide;
}

describe('createSlide', () => {
  it('slides as a Web Animation of the transform, and lands where it was sent', async () => {
    const el = box();
    const slide = slideOf(el);
    slide.slideTo(240);
    const [animation] = el.getAnimations();
    expect(animation).toBeDefined();
    const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
    expect(keyframes.some((k) => typeof k.transform === 'string')).toBe(true);
    await landsAt(el, 240);
    expect(el.style.transform).toBe('translateX(240px)');
    expect(slide.get()).toBe(240);

    slide.slideTo(0);
    await landsAt(el, 0);
    // At rest over the list it has no transform at all.
    expect(el.style.transform).toBe('');
    el.remove();
  });

  // Times are pinned (the clock the slide reads, and the animation's own) so
  // a loaded machine can't carry a slide past where a test looks at it.
  function pinClock() {
    const t0 = performance.now();
    const now = vi.spyOn(performance, 'now').mockReturnValue(t0);
    return { at: (ms: number) => now.mockReturnValue(t0 + ms), restore: () => now.mockRestore() };
  }

  it('caught mid-way, stays where it was shown', () => {
    const el = box();
    const slide = slideOf(el);
    const clock = pinClock();
    try {
      slide.slideTo(300);
      const [animation] = el.getAnimations();
      animation.pause();
      animation.currentTime = 60;
      const shown = shownAt(el);
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(300);

      clock.at(60);
      slide.stop();
      expect(el.getAnimations()).toHaveLength(0);
      expect(shownAt(el)).toBeCloseTo(shown, 0);
      expect(slide.get()).toBeCloseTo(shown, 0);
      // Stopping again, or a slide at rest, changes nothing.
      slide.stop();
      expect(slide.get()).toBeCloseTo(shown, 0);
    } finally {
      clock.restore();
      el.remove();
    }
  });

  it('reads where a slide is while it runs', () => {
    const el = box();
    const slide = slideOf(el);
    const clock = pinClock();
    try {
      slide.slideTo(300);
      expect(slide.get()).toBe(0);
      clock.at(80);
      const mid = slide.get();
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(300);
      clock.at(5000);
      expect(slide.get()).toBe(300);
      slide.stop();
    } finally {
      clock.restore();
      el.remove();
    }
  });

  it('a finger setting it ends the slide there', async () => {
    const el = box();
    const slide = slideOf(el);
    slide.slideTo(300);
    await sleep(30);
    slide.set(120);
    expect(el.getAnimations()).toHaveLength(0);
    expect(el.style.transform).toBe('translateX(120px)');
    expect(shownAt(el)).toBe(120);
    expect(slide.get()).toBe(120);
    el.remove();
  });

  it('carries the speed it is given: a flung slide is further along', () => {
    const a = box();
    const b = box();
    const still = slideOf(a);
    const flung = slideOf(b);
    const clock = pinClock();
    try {
      still.slideTo(300);
      flung.slideTo(300, 4000);
      clock.at(40);
      expect(flung.get()).toBeGreaterThan(still.get());
      still.stop();
      flung.stop();
    } finally {
      clock.restore();
      a.remove();
      b.remove();
    }
  });

  it('is already there: no animation', () => {
    const el = box();
    const slide = slideOf(el, 50);
    slide.slideTo(50);
    expect(el.getAnimations()).toHaveLength(0);
    expect(el.style.transform).toBe('translateX(50px)');
    el.remove();
  });

  it('without an element, only keeps the position', () => {
    const slide: Slide = createSlide(0);
    slide.slideTo(100);
    expect(slide.get()).toBe(100);
    slide.set(20);
    expect(slide.get()).toBe(20);
  });
});

function Harness({ onReady }: { onReady: (slide: Slide, el: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const slide = useSlide(ref, 0);
  useEffect(() => onReady(slide, ref.current!), [onReady, slide]);
  return <div ref={ref} style={{ width: 100, height: 100 }} />;
}

describe('useSlide', () => {
  it('slides the element in the ref, and stops when it goes', async () => {
    let slide: Slide | null = null;
    let el: HTMLElement | null = null;
    const screen = await render(
      <Harness
        onReady={(s, node) => {
          slide = s;
          el = node;
        }}
      />,
    );
    slide!.slideTo(200);
    const [animation] = el!.getAnimations();
    expect(animation).toBeDefined();
    // Held mid-way, however slow the machine: only going away ends it.
    animation.pause();
    await screen.unmount();
    // A paused animation stays until it is cancelled.
    expect(el!.getAnimations()).toHaveLength(0);
  });
});
