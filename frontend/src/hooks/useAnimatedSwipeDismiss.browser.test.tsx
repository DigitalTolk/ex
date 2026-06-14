import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { useSwipeable } from 'react-swipeable';
import { useAnimatedSwipeDismiss } from './useAnimatedSwipeDismiss';

// Mirrors the jsdom test but runs under the browser coverage gate (the hook is
// measured by both configs). react-swipeable is mocked so the gesture-callback
// branches can be driven directly with crafted swipe events. The hook's output
// is rendered into data-attributes and read back from the DOM.
vi.mock('react-swipeable', () => ({
  useSwipeable: vi.fn((config) => ({ ref: vi.fn(), ...config })),
}));

interface SwipeConfig {
  preventScrollOnSwipe: boolean;
  onSwiping: (e: { absX: number; absY: number; deltaX: number; deltaY: number; initial: [number, number]; event: Event }) => void;
  onSwipedRight: (e: { absY: number; deltaX: number; initial: [number, number] }) => void;
  onSwipedDown: (e: { absX: number; deltaY: number; event: Event }) => void;
  onSwiped: () => void;
}

function swipeConfig() {
  return vi.mocked(useSwipeable).mock.calls.at(-1)?.[0] as SwipeConfig;
}

function tick() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

function probe() {
  return document.querySelector('[data-testid="swipe-probe"]') as HTMLElement;
}
function transform() {
  return probe().getAttribute('data-transform') ?? '';
}
function offset() {
  return probe().getAttribute('data-offset');
}
function dismissing() {
  return probe().getAttribute('data-dismissing');
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

function Probe({ direction, onDismiss }: { direction: 'right' | 'down'; onDismiss: () => void }) {
  const r = useAnimatedSwipeDismiss(direction, onDismiss);
  return (
    <div
      data-testid="swipe-probe"
      data-offset={r.dragOffset}
      data-dismissing={String(r.dismissing)}
      data-transform={r.dragStyle?.transform ?? ''}
    />
  );
}

function eventFor(target: EventTarget = document.body, cancelable = true) {
  return { target, cancelable, preventDefault: vi.fn() } as unknown as Event;
}

describe('useAnimatedSwipeDismiss (browser)', () => {
  beforeEach(() => setMobileMatch(true));

  it('tracks a rightward drag offset and settles back when the swipe is cancelled', async () => {
    const onDismiss = vi.fn();
    await render(<Probe direction="right" onDismiss={onDismiss} />);

    swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120], event: eventFor() });
    await vi.waitFor(() => expect(transform()).toBe('translateX(60px)'));

    swipeConfig().onSwipedRight({ absY: 8, deltaX: 60, initial: [12, 120] });
    await vi.waitFor(() => expect(offset()).toBe('0'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('ignores wrong-direction, diagonal, and non-edge right drags', async () => {
    await render(<Probe direction="right" onDismiss={vi.fn()} />);
    swipeConfig().onSwiping({ absX: 20, absY: 4, deltaX: -20, deltaY: 4, initial: [12, 120], event: eventFor() });
    swipeConfig().onSwiping({ absX: 80, absY: 80, deltaX: 80, deltaY: 80, initial: [12, 120], event: eventFor() });
    swipeConfig().onSwiping({ absX: 80, absY: 8, deltaX: 80, deltaY: 8, initial: [120, 160], event: eventFor() });
    await tick();
    expect(transform()).toBe('');
  });

  it('does not call preventDefault on a non-cancelable rightward swipe', async () => {
    await render(<Probe direction="right" onDismiss={vi.fn()} />);
    const event = eventFor(document.body, false);
    swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120], event });
    await vi.waitFor(() => expect(transform()).toBe('translateX(60px)'));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('commits a rightward dismissal once, ignoring duplicate commits mid-animation', async () => {
    const onDismiss = vi.fn();
    await render(<Probe direction="right" onDismiss={onDismiss} />);
    swipeConfig().onSwipedRight({ absY: 8, deltaX: 100, initial: [12, 120] });
    await vi.waitFor(() => expect(dismissing()).toBe('true'));
    // A second commit while the timer is pending is ignored.
    swipeConfig().onSwipedRight({ absY: 8, deltaX: 100, initial: [12, 120] });
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('tracks a downward drag and dismisses a bottom sheet', async () => {
    const onDismiss = vi.fn();
    await render(<Probe direction="down" onDismiss={onDismiss} />);
    swipeConfig().onSwiping({ absX: 8, absY: 80, deltaX: 8, deltaY: 80, initial: [120, 120], event: eventFor() });
    await vi.waitFor(() => expect(transform()).toBe('translateY(80px)'));
    swipeConfig().onSwipedDown({ absX: 8, deltaY: 80, event: eventFor() });
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('ignores wrong-direction down drags and does not call preventDefault when non-cancelable', async () => {
    await render(<Probe direction="down" onDismiss={vi.fn()} />);
    const event = eventFor(document.body, false);
    swipeConfig().onSwiping({ absX: 80, absY: 8, deltaX: 80, deltaY: 8, initial: [120, 120], event: eventFor() });
    swipeConfig().onSwiping({ absX: 8, absY: 80, deltaX: 8, deltaY: 80, initial: [120, 120], event });
    await vi.waitFor(() => expect(transform()).toBe('translateY(80px)'));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('does not hijack a downward swipe when the picker is already scrolled', async () => {
    await render(<Probe direction="down" onDismiss={vi.fn()} />);
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    Object.defineProperty(scroller, 'scrollTop', { value: 40, configurable: true });
    document.body.appendChild(scroller);
    const child = document.createElement('span');
    scroller.appendChild(child);
    swipeConfig().onSwiping({ absX: 8, absY: 80, deltaX: 8, deltaY: 80, initial: [120, 120], event: eventFor(child) });
    swipeConfig().onSwipedDown({ absX: 8, deltaY: 80, event: eventFor(child) });
    await tick();
    expect(offset()).toBe('0');
    scroller.remove();
  });

  it('bails out of all swipe motion on a desktop-width layout', async () => {
    setMobileMatch(false);
    const onDismiss = vi.fn();
    await render(<Probe direction="right" onDismiss={onDismiss} />);
    swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120], event: eventFor() });
    swipeConfig().onSwipedRight({ absY: 8, deltaX: 100, initial: [12, 120] });
    swipeConfig().onSwipedDown({ absX: 8, deltaY: 80, event: eventFor() });
    await tick();
    expect(transform()).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
