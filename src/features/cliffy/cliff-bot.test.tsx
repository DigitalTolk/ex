import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';

import { CliffBot } from './cliff-bot';

// A real on-screen box: jsdom reports zeros for every rect, which would collapse
// the proximity maths (overR = 0) into something that proves nothing.
const BOX = { left: 900, top: 600, width: 72, height: 72, right: 972, bottom: 672 };
const CENTER = { x: BOX.left + BOX.width / 2, y: BOX.top + BOX.height / 2 };

let frames: FrameRequestCallback[] = [];
let cancelled: number[] = [];
let reduceMotion = false;

/** Run the animation loop's next tick at a chosen timestamp. */
function frame(now: number) {
  const cb = frames.pop();
  if (!cb) throw new Error('no animation frame was scheduled');
  act(() => {
    cb(now);
  });
}

function frames_(from: number, count: number, stepMs = 16) {
  for (let i = 0; i < count; i++) frame(from + i * stepMs);
}

function svgOf(container: HTMLElement) {
  return container.querySelector('#talkbot') as SVGSVGElement;
}

function move(x: number, y: number) {
  act(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
  });
}

beforeEach(() => {
  frames = [];
  cancelled = [];
  reduceMotion = false;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id));
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('prefers-reduced-motion') ? reduceMotion : false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    ...BOX,
    x: BOX.left,
    y: BOX.top,
    toJSON: () => BOX,
  } as DOMRect);
  vi.spyOn(performance, 'now').mockReturnValue(1000);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CliffBot controlled mode', () => {
  it('drives the state class the caller asks for and re-drives it on change', () => {
    const { container, rerender } = render(<CliffBot state="near" />);
    const svg = svgOf(container);
    expect(svg.classList.contains('is-near')).toBe(true);
    expect(svg.getAttribute('data-state')).toBe('near');

    rerender(<CliffBot state="over" />);
    expect(svg.classList.contains('is-over')).toBe(true);
    expect(svg.classList.contains('is-near')).toBe(false);
    expect(svg.getAttribute('data-state')).toBe('over');

    rerender(<CliffBot state="curious" />);
    expect(svg.classList.contains('is-curious')).toBe(true);
    rerender(<CliffBot state="idle" />);
    expect(svg.classList.contains('is-away')).toBe(true);
  });

  it('keeps the same SVG node across re-renders', () => {
    // React re-sets innerHTML whenever the dangerouslySetInnerHTML object's
    // IDENTITY changes, even for an identical string. A fresh literal in render
    // therefore rebuilt the SVG on every re-render — restarting its animations
    // and leaving the tracking effect (which captures the node once and does not
    // re-run) driving a detached element, i.e. a mascot frozen for good.
    const { container, rerender } = render(<CliffBot />);
    const before = svgOf(container);
    rerender(<CliffBot className="size-8" />);
    expect(svgOf(container)).toBe(before);

    // …and it is still the live node the loop is driving.
    move(CENTER.x + 4, CENTER.y);
    frame(1100);
    expect(svgOf(container).getAttribute('data-state')).toBe('over');
  });

  it('never starts the cursor loop when it is controlled', () => {
    render(<CliffBot state="idle" />);
    expect(frames).toHaveLength(0);
  });

  it('stays inert when interactivity is switched off', () => {
    render(<CliffBot interactive={false} />);
    expect(frames).toHaveLength(0);
  });

  it('respects a reduced-motion preference', () => {
    reduceMotion = true;
    const { container } = render(<CliffBot />);
    expect(frames).toHaveLength(0);
    expect(svgOf(container).getAttribute('data-state')).toBeNull();
  });

  it('does nothing at all if the generated markup ever loses #talkbot', async () => {
    // The markup is extracted from /cliff-bot.html by hand, so a revision that
    // renames or drops #talkbot is a live possibility — both effects must bail
    // rather than throw. Re-import against a mocked markup module, since the
    // component snapshots it into a module constant at load time.
    vi.resetModules();
    vi.doMock('./cliff-bot-markup', () => ({ CLIFF_BOT_SVG: '<svg><g id="somethingElse" /></svg>' }));
    const { CliffBot: Bare } = await import('./cliff-bot');

    const controlled = render(<Bare state="near" />);
    expect(controlled.container.querySelector('#talkbot')).toBeNull();
    controlled.unmount();

    const { container } = render(<Bare />);
    expect(container.querySelector('#talkbot')).toBeNull();
    expect(frames).toHaveLength(0);

    vi.doUnmock('./cliff-bot-markup');
    vi.resetModules();
  });
});

describe('CliffBot cursor tracking', () => {
  it('starts away and reports its state to the host', () => {
    const onStateChange = vi.fn();
    const { container } = render(<CliffBot onStateChange={onStateChange} />);
    expect(svgOf(container).getAttribute('data-state')).toBe('idle');
    expect(onStateChange).toHaveBeenCalledWith('idle');
    expect(frames).toHaveLength(1);
  });

  it('gets excited near the cursor and happy under it', () => {
    const onStateChange = vi.fn();
    const { container } = render(<CliffBot onStateChange={onStateChange} />);
    const svg = svgOf(container);

    // Just outside the "over" radius (72 * 0.55 ≈ 40) but inside nearPx.
    move(CENTER.x + 60, CENTER.y);
    frame(1100);
    expect(svg.getAttribute('data-state')).toBe('near');

    move(CENTER.x + 4, CENTER.y);
    frame(1120);
    expect(svg.getAttribute('data-state')).toBe('over');
    expect(onStateChange).toHaveBeenLastCalledWith('over');

    // Far away again → back to idle.
    move(CENTER.x + 800, CENTER.y);
    frame(1140);
    expect(svg.getAttribute('data-state')).toBe('idle');
  });

  it('honours a custom excitement radius', () => {
    const { container } = render(<CliffBot nearPx={400} />);
    move(CENTER.x + 300, CENTER.y);
    frame(1100);
    expect(svgOf(container).getAttribute('data-state')).toBe('near');
  });

  it('tracks the cursor with its eyes and drifts them home once it is out of range', () => {
    const { container } = render(<CliffBot />);
    const svg = svgOf(container);
    const leftEye = () => svg.querySelector('#leftEye')!.getAttribute('transform')!;

    const offsetX = () => Number.parseFloat(leftEye().split(',')[4]) - 45.96;

    move(CENTER.x + 200, CENTER.y + 120);
    frames_(1100, 12);
    const tracking = offsetX();
    expect(Math.abs(tracking)).toBeGreaterThan(1);

    // Beyond EYE_FOLLOW_PX (1200) the eyes ease back to centre instead of
    // straining at a cursor on the far side of the screen. It's an easing, so
    // assert it has essentially arrived rather than pinning an exact frame.
    move(CENTER.x + 4000, CENTER.y);
    frames_(1400, 90);
    expect(Math.abs(offsetX())).toBeLessThan(0.05);
    expect(Math.abs(offsetX())).toBeLessThan(Math.abs(tracking));
  });

  it('forgets the cursor when it leaves the window or the tab loses focus', () => {
    const { container } = render(<CliffBot />);
    const svg = svgOf(container);
    move(CENTER.x + 4, CENTER.y);
    frame(1100);
    expect(svg.getAttribute('data-state')).toBe('over');

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerleave'));
    });
    frame(1120);
    expect(svg.getAttribute('data-state')).toBe('idle');

    move(CENTER.x + 4, CENTER.y);
    frame(1140);
    expect(svg.getAttribute('data-state')).toBe('over');
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    frame(1160);
    expect(svg.getAttribute('data-state')).toBe('idle');
  });

  it('re-measures its box when the page resizes or scrolls', () => {
    render(<CliffBot />);
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    rect.mockClear();
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
    });
    // A stale rect would make the cat track the cursor against where it used to be.
    expect(rect).toHaveBeenCalledTimes(2);
  });

  it('uses the SVG matrix to place the eyes when the engine offers one', () => {
    // jsdom implements neither of these, which is exactly why the component has
    // a rect-based fallback (used by every other test here). Supply them so the
    // precise path real browsers take is covered too.
    const point = { x: 0, y: 0, matrixTransform: vi.fn(() => ({ x: 200, y: 200 })) };
    const { container } = render(<CliffBot />);
    const svg = svgOf(container);
    Object.assign(svg, {
      getScreenCTM: () => ({ inverse: () => ({}) }),
      createSVGPoint: () => point,
    });

    move(CENTER.x + 100, CENTER.y);
    frame(1100);
    expect(point.matrixTransform).toHaveBeenCalled();
    expect(point.x).toBe(CENTER.x + 100);
  });

  it('wanders toward a long-resting cursor, then greets it and walks back', () => {
    const onStateChange = vi.fn();
    const { container } = render(<CliffBot onStateChange={onStateChange} />);
    const svg = svgOf(container);
    const host = container.querySelector('span')!;

    // A cursor parked outside the excitement radius…
    move(CENTER.x + 600, CENTER.y + 300);
    frame(1100);
    expect(svg.getAttribute('data-state')).toBe('idle');

    // …and then five minutes of stillness (IDLE_MS) makes the cat curious and
    // set off on a wandering approach, driven frame by frame.
    frames_(1000 + 300_001, 40);
    expect(svg.getAttribute('data-state')).toBe('curious');
    expect(onStateChange).toHaveBeenCalledWith('curious');
    expect(host.style.transform).toMatch(/^translate\(-?[\d.]+px, -?[\d.]+px\)$/);
    expect(host.style.transition).toBe('none');

    // The cursor moves again → a happy greeting and a glide home, even though
    // the cursor is nowhere near the cat.
    performance.now = vi.fn(() => 400_000) as unknown as typeof performance.now;
    move(CENTER.x + 600, CENTER.y + 300);
    expect(host.style.transform).toBe('');
    expect(host.style.transition).toContain('cubic-bezier');
    frame(400_100);
    expect(svg.getAttribute('data-state')).toBe('over');

    // Once the greeting window (1.1s) closes it settles back to idle.
    frame(402_000);
    expect(svg.getAttribute('data-state')).toBe('idle');
  });

  it('stops the loop and drops its transform on unmount', () => {
    const { container, unmount } = render(<CliffBot />);
    const host = container.querySelector('span')!;
    move(CENTER.x + 600, CENTER.y + 300);
    frames_(1000 + 300_001, 20);
    expect(host.style.transform).not.toBe('');

    unmount();
    expect(cancelled).toHaveLength(1);
    expect(host.style.transform).toBe('');
  });

  it('keeps calling the latest onStateChange after the host swaps it', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { container, rerender } = render(<CliffBot onStateChange={first} />);
    rerender(<CliffBot onStateChange={second} />);
    first.mockClear();

    move(CENTER.x + 4, CENTER.y);
    frame(1100);
    expect(svgOf(container).getAttribute('data-state')).toBe('over');
    expect(second).toHaveBeenCalledWith('over');
    expect(first).not.toHaveBeenCalled();
  });
});
