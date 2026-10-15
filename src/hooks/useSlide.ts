import { useLayoutEffect, useState, type RefObject } from 'react';
import { animate, spring, type AnimationPlaybackControls } from 'motion/react';
import { SWIPE_SPRING } from '@/lib/swipe';
import type { SwipeValue } from '@/hooks/useAxisSwipe';

// A sideways position for an element, in px, moved two ways. A finger moves
// it directly (set), from the swipe's pointer events. Anything else — a back
// button, a row picked, a route, a released swipe — slides it with the swipe
// spring, which Motion runs as a Web Animation of the element's transform.
// The browser plays that on its compositor, so the page rendering under the
// slide (a whole conversation mounting) can't stall it: a slide driven from
// JS, frame by frame, froze for as long as that render took.
export interface Slide extends SwipeValue {
  // Spring to `target`, setting off at `velocity` px/s.
  slideTo(target: number, velocity?: number): void;
}

interface Running {
  controls: AnimationPlaybackControls;
  startedAt: number;
  // Where the slide is `ms` after it set off. A Web Animation doesn't say
  // where it is, so a slide caught mid-way is placed by the same spring.
  at: (ms: number) => number;
}

// A slide of whichever element is attached; none moves nothing.
export function createSlide(initial: number): Slide & { attach(el: HTMLElement | null): void } {
  let x = initial;
  let el: HTMLElement | null = null;
  let running: Running | null = null;
  const place = (value: number) => {
    x = value;
    if (el) el.style.transform = value === 0 ? '' : `translateX(${value}px)`;
  };
  const get = () => (running ? running.at(performance.now() - running.startedAt) : x);
  const stop = () => {
    if (!running) return;
    const here = get();
    running.controls.cancel();
    running = null;
    place(here);
  };
  return {
    attach(node) {
      el = node;
    },
    get,
    stop,
    set(value) {
      stop();
      place(value);
    },
    slideTo(target, velocity = 0) {
      stop();
      const from = x;
      if (!el || from === target) {
        place(target);
        return;
      }
      const { stiffness, damping } = SWIPE_SPRING;
      const path = spring({ keyframes: [from, target], velocity, stiffness, damping });
      // Motion springs a transform from 0 to 100% of the way, so its speed
      // is given in % of the distance per second. A slide that is stopped
      // never completes; the next one has stopped this one before it starts.
      const controls = animate(
        el,
        { transform: [`translateX(${from}px)`, `translateX(${target}px)`] },
        {
          ...SWIPE_SPRING,
          velocity: (velocity / (target - from)) * 100,
          onComplete: () => {
            running = null;
            place(target);
          },
        },
      );
      // Hand it to the browser now. Motion would otherwise start it on its
      // next frame, and a page rendering in the meantime holds that frame.
      controls.play();
      x = target;
      running = { controls, startedAt: performance.now(), at: (ms) => path.next(ms).value };
    },
  };
}

// The slide for the element in `ref`, starting at `initial` (written the
// first time it is placed or slid). It takes hold of the element before
// layout effects declared after it run, so they can slide it at once.
export function useSlide(ref: RefObject<HTMLElement | null>, initial: number): Slide {
  const [slide] = useState(() => createSlide(initial));
  useLayoutEffect(() => {
    slide.attach(ref.current);
    return () => {
      slide.stop();
      slide.attach(null);
    };
  }, [slide, ref]);
  return slide;
}
