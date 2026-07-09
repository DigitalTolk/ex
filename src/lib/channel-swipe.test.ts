import { describe, it, expect } from 'vitest';
import {
  CHANNEL_OPEN_AXIS_LOCK_PX,
  channelDragTransform,
  CHANNEL_OPEN_EDGE_PX,
  CHANNEL_OPEN_MIN_DELTA_TO_COMMIT,
  CHANNEL_OPEN_PX_THRESHOLD,
  clampChannelOffset,
  latchChannelSwipe,
  shouldCommitChannelSwipe,
} from './channel-swipe';

describe('latchChannelSwipe', () => {
  const base = { absX: 40, absY: 0, deltaX: 40, startX: 4, mobileChannelsOpen: false, canOpen: true };

  it('stays null until the axis lock is passed', () => {
    expect(latchChannelSwipe({ ...base, absX: CHANNEL_OPEN_AXIS_LOCK_PX - 1, deltaX: 5 })).toBeNull();
  });

  it('stays null when the gesture is more vertical than horizontal', () => {
    expect(latchChannelSwipe({ ...base, absX: 30, absY: 35 })).toBeNull();
  });

  it('latches open from a left-edge rightward drag', () => {
    expect(latchChannelSwipe({ ...base, deltaX: 40, startX: CHANNEL_OPEN_EDGE_PX })).toBe('open');
  });

  it('does not open from a mid-screen start', () => {
    expect(latchChannelSwipe({ ...base, startX: CHANNEL_OPEN_EDGE_PX + 1 })).toBeNull();
  });

  it('does not open when opening is disallowed', () => {
    expect(latchChannelSwipe({ ...base, canOpen: false })).toBeNull();
  });

  it('latches close from a leftward drag when the pane is open', () => {
    expect(latchChannelSwipe({ ...base, mobileChannelsOpen: true, deltaX: -40, startX: 200 })).toBe('close');
  });

  it('does not close on a rightward drag when open', () => {
    expect(latchChannelSwipe({ ...base, mobileChannelsOpen: true, deltaX: 40 })).toBeNull();
  });
});

describe('clampChannelOffset', () => {
  it('clamps the open drag to [0, viewport]', () => {
    expect(clampChannelOffset('open', -20, 500)).toBe(0);
    expect(clampChannelOffset('open', 600, 500)).toBe(500);
    expect(clampChannelOffset('open', 120, 500)).toBe(120);
  });

  it('clamps the close drag to [-viewport, 0]', () => {
    expect(clampChannelOffset('close', 20, 500)).toBe(0);
    expect(clampChannelOffset('close', -600, 500)).toBe(-500);
    expect(clampChannelOffset('close', -120, 500)).toBe(-120);
  });
});

describe('shouldCommitChannelSwipe', () => {
  it('commits when the pixel threshold is met', () => {
    expect(shouldCommitChannelSwipe({ absX: CHANNEL_OPEN_PX_THRESHOLD, velocityPxPerMs: 0 })).toBe(true);
  });

  it('commits on a fast flick past the minimum delta', () => {
    expect(shouldCommitChannelSwipe({ absX: CHANNEL_OPEN_MIN_DELTA_TO_COMMIT, velocityPxPerMs: 1 })).toBe(true);
  });

  it('does not commit a fast flick that is too short', () => {
    expect(shouldCommitChannelSwipe({ absX: CHANNEL_OPEN_MIN_DELTA_TO_COMMIT - 1, velocityPxPerMs: 1 })).toBe(false);
  });

  it('does not commit a slow short drag', () => {
    expect(shouldCommitChannelSwipe({ absX: 30, velocityPxPerMs: 0.1 })).toBe(false);
  });
});

describe('channelDragTransform', () => {
  it('returns the resting closed/open transform at zero offset', () => {
    expect(channelDragTransform(0, false)).toBe('translate3d(0px, 0, 0)');
    expect(channelDragTransform(0, true)).toBe('translate3d(100vw, 0, 0)');
  });

  it('blends a positive (opening) drag onto the closed rest', () => {
    expect(channelDragTransform(40, false)).toBe('translate3d(calc(0px + 40px), 0, 0)');
  });

  it('blends a negative (closing) drag onto the open rest', () => {
    expect(channelDragTransform(-40, true)).toBe('translate3d(calc(100vw - 40px), 0, 0)');
  });
});
