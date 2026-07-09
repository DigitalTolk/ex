import { describe, expect, it } from 'vitest';
import {
  classifyDoubleTap,
  classifySwipe,
  idleGesture,
  isTapRelease,
  onPointerDown,
  readPanUpdate,
  readPinchUpdate,
  readSwipeDrag,
  trackSwipe,
  tryInvalidateTap,
  type GestureState,
} from './lightbox-gestures';

const baseCtx = { isImage: true, isMobile: true, zoom: 1, panX: 0, panY: 0 };

describe('lightbox-gestures.onPointerDown', () => {
  it('first finger on a non-zoomed image → swipe state with tap candidate', () => {
    const out = onPointerDown(
      idleGesture,
      { pointerId: 1, x: 100, y: 100, pointerType: 'touch', time: 1000 },
      [{ pointerId: 1, x: 100, y: 100 }],
      baseCtx,
    );
    expect(out.state.kind).toBe('swipe');
    expect(out.tapStart?.kind).toBe('tap-pending');
  });

  it('zoomed image → pan state, but tap candidate still captured for double-tap zoom-out', () => {
    const out = onPointerDown(
      idleGesture,
      { pointerId: 1, x: 100, y: 100, pointerType: 'touch', time: 1000 },
      [{ pointerId: 1, x: 100, y: 100 }],
      { ...baseCtx, zoom: 2 },
    );
    expect(out.state.kind).toBe('pan');
    expect(out.tapStart?.kind).toBe('tap-pending');
  });

  it('second finger on an image → pinch wins, tap is invalidated', () => {
    const out = onPointerDown(
      idleGesture,
      { pointerId: 2, x: 200, y: 100, pointerType: 'touch', time: 1010 },
      [{ pointerId: 1, x: 100, y: 100 }, { pointerId: 2, x: 200, y: 100 }],
      baseCtx,
    );
    expect(out.state.kind).toBe('pinch');
    expect(out.tapStart).toBeNull();
  });

  it('mouse pointer never captures a tap candidate', () => {
    const out = onPointerDown(
      idleGesture,
      { pointerId: 1, x: 100, y: 100, pointerType: 'mouse', time: 1000 },
      [{ pointerId: 1, x: 100, y: 100 }],
      baseCtx,
    );
    expect(out.tapStart).toBeNull();
  });

  it('non-mobile pointerdown is a no-op', () => {
    const out = onPointerDown(
      idleGesture,
      { pointerId: 1, x: 100, y: 100, pointerType: 'mouse', time: 1000 },
      [{ pointerId: 1, x: 100, y: 100 }],
      { ...baseCtx, isMobile: false, isImage: true },
    );
    expect(out.state.kind).toBe('idle');
  });

  it('non-mobile pointerdown resets a previously non-idle gesture to idle', () => {
    const stale: GestureState = { kind: 'swipe', pointerId: 9, startX: 0, startY: 0, lastX: 0, lastY: 0 };
    const out = onPointerDown(
      stale,
      { pointerId: 1, x: 100, y: 100, pointerType: 'mouse', time: 1000 },
      [{ pointerId: 1, x: 100, y: 100 }],
      { ...baseCtx, isMobile: false, isImage: true },
    );
    // prev was not idle, so a fresh idle state is returned (not the stale one).
    expect(out.state).toEqual({ kind: 'idle' });
    expect(out.state).not.toBe(stale);
  });
});

describe('lightbox-gestures.tryInvalidateTap', () => {
  const tap: GestureState = { kind: 'tap-pending', pointerId: 1, startTime: 1000, startX: 100, startY: 100 };

  it('keeps tap-pending while finger is still within 12px', () => {
    const result = tryInvalidateTap(tap, { pointerId: 1, x: 105, y: 103 });
    expect(result?.kind).toBe('tap-pending');
  });

  it('cancels tap-pending once finger has moved past 12px', () => {
    const result = tryInvalidateTap(tap, { pointerId: 1, x: 130, y: 100 });
    expect(result).toBeNull();
  });

  it('ignores moves on a different pointer (multi-touch coexisting)', () => {
    const result = tryInvalidateTap(tap, { pointerId: 99, x: 999, y: 999 });
    expect(result).toBe(tap);
  });
});

describe('lightbox-gestures.isTapRelease', () => {
  const tap: GestureState = { kind: 'tap-pending', pointerId: 1, startTime: 1000, startX: 100, startY: 100 };

  it('release within 350ms and 12px = a tap', () => {
    expect(isTapRelease(tap, { pointerId: 1, x: 105, y: 102, time: 1200 }, [])).toBe(true);
  });

  it('release after 350ms = not a tap (long-press)', () => {
    expect(isTapRelease(tap, { pointerId: 1, x: 100, y: 100, time: 1500 }, [])).toBe(false);
  });

  it('release with movement >12px = not a tap', () => {
    expect(isTapRelease(tap, { pointerId: 1, x: 130, y: 100, time: 1100 }, [])).toBe(false);
  });

  it('release with another pointer still active = not a tap', () => {
    expect(isTapRelease(tap, { pointerId: 1, x: 100, y: 100, time: 1100 }, [{ pointerId: 2, x: 0, y: 0 }])).toBe(false);
  });
});

describe('lightbox-gestures.classifyDoubleTap', () => {
  it('two taps within 450ms and 56px chain into a double-tap', () => {
    expect(
      classifyDoubleTap({ time: 1000, x: 100, y: 100 }, { time: 1300, x: 110, y: 105 }),
    ).toBe(true);
  });

  it('a long pause between taps does NOT chain', () => {
    expect(
      classifyDoubleTap({ time: 1000, x: 100, y: 100 }, { time: 1500, x: 110, y: 105 }),
    ).toBe(false);
  });

  it('a far-apart second tap does NOT chain', () => {
    expect(
      classifyDoubleTap({ time: 1000, x: 100, y: 100 }, { time: 1100, x: 200, y: 100 }),
    ).toBe(false);
  });

  it('no previous tap (first finger ever) does NOT chain', () => {
    expect(classifyDoubleTap(null, { time: 1000, x: 100, y: 100 })).toBe(false);
  });
});

describe('lightbox-gestures.readSwipeDrag', () => {
  const swipe: GestureState = { kind: 'swipe', pointerId: 1, startX: 100, startY: 100, lastX: 100, lastY: 100 };

  it('movement under threshold returns null (no drag yet)', () => {
    expect(readSwipeDrag(swipe, { pointerId: 1, x: 110, y: 100 })).toBeNull();
  });

  it('horizontal swipe → only x is reported', () => {
    expect(readSwipeDrag(swipe, { pointerId: 1, x: 200, y: 105 })).toEqual({ dx: 100, dy: 0 });
  });

  it('downward swipe → only y is reported (and only positive)', () => {
    expect(readSwipeDrag(swipe, { pointerId: 1, x: 105, y: 200 })).toEqual({ dx: 0, dy: 100 });
  });

  it('upward swipe → no drag (close gesture is downward only)', () => {
    expect(readSwipeDrag(swipe, { pointerId: 1, x: 105, y: 0 })).toEqual({ dx: 0, dy: 0 });
  });

  it('ignores other pointer ids', () => {
    expect(readSwipeDrag(swipe, { pointerId: 99, x: 200, y: 100 })).toBeNull();
  });
});

describe('lightbox-gestures.classifySwipe', () => {
  const swipe: GestureState = { kind: 'swipe', pointerId: 1, startX: 200, startY: 200, lastX: 200, lastY: 200 };

  it('big downward drop → close', () => {
    const out = classifySwipe(swipe, { pointerId: 1, x: 210, y: 350 }, false, true);
    expect(out.kind).toBe('close');
  });

  it('returns none when the release pointer is not the swipe pointer', () => {
    // pointerId mismatch trips the guard before any geometry is computed.
    const out = classifySwipe(swipe, { pointerId: 2, x: 210, y: 350 }, false, true);
    expect(out).toEqual({ kind: 'none', dx: 0, dy: 0 });
  });

  it('left swipe past threshold → next', () => {
    const out = classifySwipe(swipe, { pointerId: 1, x: 50, y: 210 }, false, true);
    expect(out.kind).toBe('next');
  });

  it('right swipe past threshold → prev', () => {
    const out = classifySwipe(swipe, { pointerId: 1, x: 350, y: 210 }, false, true);
    expect(out.kind).toBe('prev');
  });

  it('navigation suppressed when only one image', () => {
    const out = classifySwipe(swipe, { pointerId: 1, x: 50, y: 210 }, false, false);
    expect(out.kind).toBe('none');
  });

  it('zoomed image → all swipes suppressed (user is panning)', () => {
    const close = classifySwipe(swipe, { pointerId: 1, x: 210, y: 350 }, true, true);
    const nav = classifySwipe(swipe, { pointerId: 1, x: 50, y: 210 }, true, true);
    expect(close.kind).toBe('none');
    expect(nav.kind).toBe('none');
  });

  it('movement below threshold → no commitment', () => {
    const out = classifySwipe(swipe, { pointerId: 1, x: 220, y: 210 }, false, true);
    expect(out.kind).toBe('none');
  });
});

describe('lightbox-gestures.readPanUpdate / readPinchUpdate', () => {
  it('readPanUpdate maps cursor delta onto pan offset', () => {
    const state: GestureState = { kind: 'pan', pointerId: 1, startX: 100, startY: 100, originX: 50, originY: 50 };
    const result = readPanUpdate(state, { pointerId: 1, x: 200, y: 150 });
    expect(result).toEqual({ panX: 150, panY: 100 });
  });

  it('readPanUpdate ignores other gestures and other pointers', () => {
    const state: GestureState = { kind: 'pan', pointerId: 1, startX: 100, startY: 100, originX: 0, originY: 0 };
    expect(readPanUpdate(state, { pointerId: 99, x: 200, y: 150 })).toBeNull();
    expect(readPanUpdate({ kind: 'idle' }, { pointerId: 1, x: 200, y: 150 })).toBeNull();
  });

  it('readPinchUpdate scales zoom proportionally to pointer distance', () => {
    const state: GestureState = {
      kind: 'pinch',
      startDistance: 100,
      startZoom: 1,
      centerX: 200,
      centerY: 200,
      originX: 0,
      originY: 0,
    };
    const result = readPinchUpdate(
      state,
      [{ pointerId: 1, x: 100, y: 200 }, { pointerId: 2, x: 300, y: 200 }],
    );
    expect(result?.zoom).toBe(2); // distance doubled, zoom doubles
  });

  it('readPinchUpdate caps zoom at 6x', () => {
    const state: GestureState = {
      kind: 'pinch',
      startDistance: 50,
      startZoom: 1,
      centerX: 200,
      centerY: 200,
      originX: 0,
      originY: 0,
    };
    const result = readPinchUpdate(
      state,
      [{ pointerId: 1, x: 0, y: 200 }, { pointerId: 2, x: 1000, y: 200 }],
    );
    expect(result?.zoom).toBe(6);
  });
});

describe('lightbox-gestures.trackSwipe', () => {
  it('updates lastX/lastY on swipe but leaves other states untouched', () => {
    const swipe: GestureState = { kind: 'swipe', pointerId: 1, startX: 0, startY: 0, lastX: 0, lastY: 0 };
    const next = trackSwipe(swipe, { pointerId: 1, x: 50, y: 30 });
    if (next.kind !== 'swipe') throw new Error('expected swipe state');
    expect(next.lastX).toBe(50);
    expect(next.lastY).toBe(30);
    expect(trackSwipe({ kind: 'idle' }, { pointerId: 1, x: 50, y: 30 })).toEqual({ kind: 'idle' });
  });
});
