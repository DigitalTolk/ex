import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useInView } from '@/hooks/useInView';

// jsdom doesn't ship IntersectionObserver — install a controllable
// stub so we can drive the in-view transition deterministically.
class FakeObserver {
  static instances: FakeObserver[] = [];
  cb: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    FakeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {
    /* no-op */
  }
  disconnect() {
    this.observed = [];
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(intersecting: boolean) {
    const entries = this.observed.map(
      (target) => ({ target, isIntersecting: intersecting }) as IntersectionObserverEntry,
    );
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

function Probe(props: { onState: (inView: boolean) => void }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  props.onState(inView);
  return <div ref={ref} data-testid="probe" />;
}

describe('useInView', () => {
  let originalIO: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    originalIO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    FakeObserver.instances = [];
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      value: FakeObserver,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (originalIO) {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: originalIO,
        configurable: true,
        writable: true,
      });
    }
  });

  it('starts with inView=false and flips true on the first intersection', () => {
    const states: boolean[] = [];
    render(<Probe onState={(v) => states.push(v)} />);
    expect(states[0]).toBe(false);
    act(() => {
      FakeObserver.instances[0].fire(true);
    });
    expect(states.at(-1)).toBe(true);
  });

  it('stays inView once true even if the element scrolls back out', () => {
    const states: boolean[] = [];
    render(<Probe onState={(v) => states.push(v)} />);
    act(() => FakeObserver.instances[0].fire(true));
    const firstSeenTrue = states.at(-1);
    expect(firstSeenTrue).toBe(true);
    // After firing again with intersecting=false, the hook does nothing
    // because the observer disconnects on first entry — guard against a
    // future rewrite that keeps observing.
    act(() => FakeObserver.instances[0].fire(false));
    expect(states.at(-1)).toBe(true);
  });

  it('falls back to inView=true when IntersectionObserver is unavailable', () => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const states: boolean[] = [];
    render(<Probe onState={(v) => states.push(v)} />);
    expect(states[0]).toBe(true);
  });
});
