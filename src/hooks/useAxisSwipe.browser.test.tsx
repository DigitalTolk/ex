import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import type { ReactNode } from 'react';
import { motion, useMotionValue } from 'motion/react';
import { useAxisSwipe, type AxisSwipeRelease } from './useAxisSwipe';
import { SWIPE_SURFACE_ATTR, swipeStartsOn } from '@/lib/swipe';

// Once a sideways swipe has taken a touch, the page must not scroll under
// it: iOS turns a sideways drag that drifts up or down into a scroll of the
// list beneath, which cancels the swipe mid-way. The swipe claims the rest of
// the touch the way the platform provides — by cancelling its touchmoves —
// and only from the moment it has taken the touch: before that, and for a
// touch that goes up or down, scrolling stays the browser's.
//
// Chromium never scrolls a touch that started sideways over pan-y, so a real
// finger can't show the iOS failure here; these drive the events themselves
// and check which moves the swipe cancels.

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function Surface({ onRelease, children }: { onRelease: (release: AxisSwipeRelease) => void; children?: ReactNode }) {
  const value = useMotionValue(0);
  const swipe = useAxisSwipe({
    enabled: true,
    axis: 'x',
    value,
    range: () => [0, 300],
    canStart: swipeStartsOn,
    onRelease,
  });
  return (
    <motion.div
      data-testid="surface"
      style={{ x: value, width: 300, height: 300 }}
      {...{ [SWIPE_SURFACE_ATTR]: 'x' }}
      {...swipe}
    >
      {children}
    </motion.div>
  );
}

let pointerId = 100;

function pointer(type: string, x: number, y: number, id: number, pointerType = 'touch') {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: id,
    isPrimary: true,
    pointerType,
    button: type === 'pointerdown' ? 0 : -1,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

// Touch events as the browser sends them while fingers are down. WebKit
// can't construct a TouchEvent (or a Touch), so these are plain events with
// the one field the swipe reads: how many fingers are still down.
function touchEvent(type: 'touchmove' | 'touchend', fingersDown: number, cancelable = type === 'touchmove'): Event {
  const event = new Event(type, { bubbles: true, cancelable });
  Object.defineProperty(event, 'touches', { value: { length: fingersDown } });
  return event;
}

// Whether a move of the finger comes back cancelled: whether the page may
// scroll from it.
function touchMoveCancelled(): boolean {
  const event = touchEvent('touchmove', 1);
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function lift(fingersLeft = 0) {
  window.dispatchEvent(touchEvent('touchend', fingersLeft));
}

async function mount(onRelease = vi.fn()) {
  const screen = await render(<Surface onRelease={onRelease} />);
  const el = screen.getByTestId('surface').element() as HTMLElement;
  const { left, top } = el.getBoundingClientRect();
  return { el, screen, at: { x: left + 50, y: top + 150 }, onRelease };
}

// Moves the finger along a straight line from `from`, one step per frame.
async function move(from: { x: number; y: number }, dx: number, dy: number, id: number, steps = 6) {
  for (let i = 1; i <= steps; i++) {
    window.dispatchEvent(pointer('pointermove', from.x + (dx * i) / steps, from.y + (dy * i) / steps, id));
    await raf();
  }
}

afterEach(() => lift());

describe('useAxisSwipe — a taken touch does not scroll the page', () => {
  it('cancels the moves of a touch only once the swipe has taken it, and not after the release', async () => {
    const { el, at, onRelease } = await mount();
    const id = pointerId++;
    el.dispatchEvent(pointer('pointerdown', at.x, at.y, id));
    expect(touchMoveCancelled()).toBe(false);

    await move(at, 60, 0, id);
    expect(touchMoveCancelled()).toBe(true);
    // Heading up or down now changes nothing: the touch is the swipe's.
    await move({ x: at.x + 60, y: at.y }, 20, -80, id);
    expect(touchMoveCancelled()).toBe(true);

    // A move the browser already scrolls with can't be taken back.
    const scrolling = touchEvent('touchmove', 1, false);
    window.dispatchEvent(scrolling);
    expect(scrolling.defaultPrevented).toBe(false);

    window.dispatchEvent(pointer('pointerup', at.x + 80, at.y - 80, id));
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(touchMoveCancelled()).toBe(false);
    lift();
    expect(touchMoveCancelled()).toBe(false);
  });

  it('leaves a touch that goes up or down to scroll natively', async () => {
    const { el, at, onRelease } = await mount();
    const id = pointerId++;
    el.dispatchEvent(pointer('pointerdown', at.x, at.y, id));
    await move(at, 2, -60, id);
    expect(touchMoveCancelled()).toBe(false);
    window.dispatchEvent(pointer('pointerup', at.x + 2, at.y - 60, id));
    lift();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('keeps holding while another finger is still down, and lets go with the last', async () => {
    const { el, at } = await mount();
    const id = pointerId++;
    el.dispatchEvent(pointer('pointerdown', at.x, at.y, id));
    // A second finger lands on the surface while the first is down.
    el.dispatchEvent(pointer('pointerdown', at.x + 100, at.y, pointerId++));
    await move(at, 60, 0, id);
    lift(1);
    expect(touchMoveCancelled()).toBe(true);
    lift();
    expect(touchMoveCancelled()).toBe(false);
  });

  it('lets go of the touch when the surface goes away mid-swipe', async () => {
    const { el, at, screen } = await mount();
    const id = pointerId++;
    el.dispatchEvent(pointer('pointerdown', at.x, at.y, id));
    await move(at, 60, 0, id);
    expect(touchMoveCancelled()).toBe(true);
    await screen.unmount();
    expect(touchMoveCancelled()).toBe(false);
  });

  it('holds nothing for a mouse, which never scrolls by dragging', async () => {
    const { el, at, onRelease } = await mount();
    const id = pointerId++;
    el.dispatchEvent(pointer('pointerdown', at.x, at.y, id, 'mouse'));
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(pointer('pointermove', at.x + i * 10, at.y, id, 'mouse'));
      await raf();
    }
    expect(touchMoveCancelled()).toBe(false);
    window.dispatchEvent(pointer('pointerup', at.x + 60, at.y, id, 'mouse'));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

// A finger landing on an avatar or a link in a conversation was offered to
// the platform's drag of that image or link instead of to the swipe.
describe('swipe surfaces on a touch screen', () => {
  it('keep their images and links from being dragged natively', async () => {
    const screen = await render(
      <Surface onRelease={vi.fn()}>
        <img alt="" data-testid="avatar" width={36} height={36} src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
        <a href="https://example.com" data-testid="link">example</a>
      </Surface>,
    );
    const drag = (testId: string) =>
      getComputedStyle(screen.getByTestId(testId).element()).getPropertyValue('-webkit-user-drag');
    const root = document.documentElement;
    const wasTouch = root.classList.contains('device-touch');
    root.classList.remove('device-touch');
    try {
      // With a mouse, dragging an image out of the app still works.
      expect(drag('avatar')).not.toBe('none');
      root.classList.add('device-touch');
      expect(drag('avatar')).toBe('none');
      expect(drag('link')).toBe('none');
    } finally {
      root.classList.toggle('device-touch', wasTouch);
    }
  });
});
