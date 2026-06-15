import { describe, expect, it } from 'vitest';
import {
  classifyDoubleTap,
  classifySwipe,
  idleGesture,
  isTapRelease,
  onPointerDown,
  readSwipeDrag,
  trackSwipe,
  tryInvalidateTap,
  type GestureState,
} from './lightbox-gestures';

// Browser-gate coverage for the gesture guard/edge branches. The jsdom
// lightbox-gestures.test.ts exercises the happy paths but is excluded from
// the jsdom gate; these pure-function guards otherwise only show as covered
// transitively via ImageLightbox, leaving the early-return branches red.

const swipe: GestureState = { kind: 'swipe', pointerId: 1, startX: 100, startY: 100, lastX: 100, lastY: 100 };

describe('lightbox-gestures guard branches (browser)', () => {
  it('onPointerDown on a desktop, non-zoomed image resets a non-idle state to idle', () => {
    const out = onPointerDown(
      swipe,
      { pointerId: 2, x: 50, y: 50, pointerType: 'mouse', time: 1000 },
      [{ pointerId: 2, x: 50, y: 50 }],
      { isImage: true, isMobile: false, zoom: 1, panX: 0, panY: 0 },
    );
    expect(out.state.kind).toBe('idle');
    expect(out.tapStart).toBeNull();
  });

  it('readSwipeDrag returns null for a non-swipe state or mismatched pointer', () => {
    expect(readSwipeDrag(idleGesture, { pointerId: 1, x: 200, y: 100 })).toBeNull();
    expect(readSwipeDrag(swipe, { pointerId: 99, x: 200, y: 100 })).toBeNull();
  });

  it('readSwipeDrag returns null while movement is under the threshold', () => {
    // Within 12px of the start → no drag feedback yet.
    expect(readSwipeDrag(swipe, { pointerId: 1, x: 108, y: 104 })).toBeNull();
  });

  it('trackSwipe leaves a non-swipe state unchanged', () => {
    expect(trackSwipe(idleGesture, { pointerId: 1, x: 5, y: 5 })).toBe(idleGesture);
  });

  it('tryInvalidateTap drops a tap-pending state once the finger moves past the threshold', () => {
    const tap: GestureState = { kind: 'tap-pending', pointerId: 1, startTime: 0, startX: 100, startY: 100 };
    // 20px away (> TAP_MAX_DISTANCE 12) → invalidated.
    expect(tryInvalidateTap(tap, { pointerId: 1, x: 120, y: 100 })).toBeNull();
    // Within range → kept.
    expect(tryInvalidateTap(tap, { pointerId: 1, x: 105, y: 100 })).toBe(tap);
  });

  it('isTapRelease rejects releases with other active pointers, too-slow, or too-far', () => {
    const tap: GestureState = { kind: 'tap-pending', pointerId: 1, startTime: 1000, startX: 100, startY: 100 };
    // Another finger still down.
    expect(isTapRelease(tap, { pointerId: 1, x: 100, y: 100, time: 1100 }, [{ pointerId: 2, x: 0, y: 0 }])).toBe(false);
    // Held too long (>= 350ms).
    expect(isTapRelease(tap, { pointerId: 1, x: 100, y: 100, time: 1400 }, [])).toBe(false);
    // Moved too far (> 12px).
    expect(isTapRelease(tap, { pointerId: 1, x: 130, y: 100, time: 1100 }, [])).toBe(false);
    // A clean quick tap in place releases.
    expect(isTapRelease(tap, { pointerId: 1, x: 102, y: 100, time: 1100 }, [])).toBe(true);
  });

  it('classifyDoubleTap rejects a second tap that lands too far from the first', () => {
    expect(classifyDoubleTap({ time: 0, x: 0, y: 0 }, { time: 100, x: 200, y: 0 })).toBe(false);
    // Close + quick → a double tap.
    expect(classifyDoubleTap({ time: 0, x: 0, y: 0 }, { time: 100, x: 10, y: 10 })).toBe(true);
  });

  it('classifySwipe returns none for a non-swipe state and while the image is pannable', () => {
    expect(classifySwipe(idleGesture, { pointerId: 1, x: 0, y: 0 }, false, true).kind).toBe('none');
    // pannableImage blocks navigation/close even with a big delta.
    expect(classifySwipe(swipe, { pointerId: 1, x: 100, y: 400 }, true, true).kind).toBe('none');
  });
});
