import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { useInView, useLiveInView } from '@/hooks/useInView';

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

// Calls the hook but never attaches the ref — the effect must bail out
// without constructing an observer.
function DetachedProbe(props: { onState: (inView: boolean) => void }) {
  const { inView } = useInView<HTMLDivElement>();
  props.onState(inView);
  return <div data-testid="detached-probe" />;
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

  it('stays out of view while entries report non-intersecting, then flips on the first hit', () => {
    const states: boolean[] = [];
    render(<Probe onState={(v) => states.push(v)} />);
    // Element starts off-screen: the observer fires with
    // isIntersecting=false and the hook must NOT flip.
    act(() => FakeObserver.instances[0].fire(false));
    expect(states.at(-1)).toBe(false);
    // Still observing — scrolling it in flips the flag.
    act(() => FakeObserver.instances[0].fire(true));
    expect(states.at(-1)).toBe(true);
  });

  it('does not observe when the ref is never attached to an element', () => {
    const states: boolean[] = [];
    render(<DetachedProbe onState={(v) => states.push(v)} />);
    expect(FakeObserver.instances).toHaveLength(0);
    expect(states.at(-1)).toBe(false);
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

function LiveProbe(props: { onState: (live: boolean) => void; attach?: boolean; measuredFor?: unknown }) {
  const ref = useRef<HTMLDivElement | null>(null);
  props.onState(useLiveInView(ref, props.measuredFor));
  return props.attach === false ? <div /> : <div ref={ref} data-testid="live-probe" />;
}

describe('useLiveInView', () => {
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

  it('is NON-sticky: tracks the element in and back OUT of the viewport', () => {
    const states: boolean[] = [];
    render(<LiveProbe onState={(v) => states.push(v)} />);
    expect(states[0]).toBe(false);
    act(() => FakeObserver.instances[0].fire(true));
    expect(states.at(-1)).toBe(true);
    // Scrolled past — a sticky flag here would keep suppressing thread
    // notifications for a card the user is no longer reading (SPEC D-3).
    act(() => FakeObserver.instances[0].fire(false));
    expect(states.at(-1)).toBe(false);
  });

  // An answer belongs to the layout it was measured in. The files panel's
  // end-of-list marker is in view while the list is empty; once 30 rows
  // render it isn't — but the browser only says so a frame later. Trusting
  // the old "in view" in between loaded the next page at once (a CI flake,
  // and a wasted request on every slow open).
  it('drops an answer measured for an earlier layout until the browser answers again', () => {
    const states: boolean[] = [];
    const { rerender } = render(<LiveProbe measuredFor={0} onState={(v) => states.push(v)} />);
    act(() => FakeObserver.instances[0].fire(true));
    expect(states.at(-1)).toBe(true);
    rerender(<LiveProbe measuredFor={30} onState={(v) => states.push(v)} />);
    expect(states.at(-1)).toBe(false);
    const fresh = FakeObserver.instances.at(-1)!;
    expect(fresh).not.toBe(FakeObserver.instances[0]);
    act(() => fresh.fire(true));
    expect(states.at(-1)).toBe(true);
  });

  it('does not observe when the ref is never attached', () => {
    const states: boolean[] = [];
    render(<LiveProbe attach={false} onState={(v) => states.push(v)} />);
    expect(FakeObserver.instances).toHaveLength(0);
    expect(states.at(-1)).toBe(false);
  });

  it('falls back to live=true when IntersectionObserver is unavailable', () => {
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const states: boolean[] = [];
    render(<LiveProbe onState={(v) => states.push(v)} />);
    expect(states[0]).toBe(true);
  });
});
