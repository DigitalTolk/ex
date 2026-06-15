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

  it('ignores further swipe motion while a dismissal animation is in flight', async () => {
    const onDismiss = vi.fn();
    await render(<Probe direction="right" onDismiss={onDismiss} />);
    // Commit a dismissal → timeoutRef is set. A subsequent onSwiping then hits
    // the `if (timeoutRef.current !== null) return` early-out.
    swipeConfig().onSwipedRight({ absY: 5, deltaX: 100, initial: [10, 100] });
    await vi.waitFor(() => expect(dismissing()).toBe('true'));
    swipeConfig().onSwiping({ absX: 60, absY: 5, deltaX: 60, deltaY: 5, initial: [10, 100], event: eventFor() });
    // Offset stays 0 (the early-out skipped setDragOffset).
    expect(offset()).toBe('0');
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('onSwiped does not reset the offset while a dismissal animation is in flight (timeoutRef !== null arm)', async () => {
    const onDismiss = vi.fn();
    await render(<Probe direction="right" onDismiss={onDismiss} />);
    // Build up a drag offset, then commit a dismissal so timeoutRef is set.
    swipeConfig().onSwiping({ absX: 60, absY: 5, deltaX: 60, deltaY: 5, initial: [10, 100], event: eventFor() });
    await vi.waitFor(() => expect(offset()).toBe('60'));
    swipeConfig().onSwipedRight({ absY: 5, deltaX: 100, initial: [10, 100] });
    // dismissWithAnimation sets timeoutRef and resets the offset to 0.
    await vi.waitFor(() => expect(dismissing()).toBe('true'));
    await vi.waitFor(() => expect(offset()).toBe('0'));
    // onSwiped fires after the gesture ends; with the timeout pending it takes
    // the `timeoutRef.current === null` FALSE arm and skips setDragOffset(0).
    swipeConfig().onSwiped();
    expect(offset()).toBe('0');
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('clears a pending dismissal timeout on unmount', async () => {
    const onDismiss = vi.fn();
    const screen = await render(<Probe direction="right" onDismiss={onDismiss} />);
    // Start the dismissal animation, then unmount before it fires → the effect
    // cleanup `if (timeoutRef.current !== null) clearTimeout(...)` runs.
    swipeConfig().onSwipedRight({ absY: 5, deltaX: 100, initial: [10, 100] });
    await vi.waitFor(() => expect(dismissing()).toBe('true'));
    await screen.unmount();
    // The animation timer was cleared, so onDismiss is never invoked.
    await new Promise((r) => setTimeout(r, 250));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('onSwiped resets the offset when no dismissal animation is pending', async () => {
    await render(<Probe direction="right" onDismiss={vi.fn()} />);
    // Track an offset, then a plain onSwiped (no commit) with no pending
    // timeout → `if (timeoutRef.current === null) setDragOffset(0)` true side.
    swipeConfig().onSwiping({ absX: 50, absY: 5, deltaX: 50, deltaY: 5, initial: [10, 100], event: eventFor() });
    await vi.waitFor(() => expect(transform()).toBe('translateX(50px)'));
    swipeConfig().onSwiped();
    await vi.waitFor(() => expect(offset()).toBe('0'));
  });

  it('treats a downward swipe over a non-Element target as not-scrollable', async () => {
    await render(<Probe direction="down" onDismiss={vi.fn()} />);
    // event.target is null → scrollContainerCanMoveUp's `target instanceof
    // Element` false side runs and the drag proceeds.
    const event = { target: null, cancelable: true, preventDefault: vi.fn() } as unknown as Event;
    swipeConfig().onSwiping({ absX: 8, absY: 80, deltaX: 8, deltaY: 80, initial: [120, 120], event });
    await vi.waitFor(() => expect(transform()).toBe('translateY(80px)'));
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
