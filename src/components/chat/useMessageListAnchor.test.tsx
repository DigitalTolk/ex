import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { Message } from '@/types';
import type { MessageListRow } from './MessageListRows';
import { useMessageListAnchor } from './useMessageListAnchor';

// A chat opened at a linked message scrolls to it, and keeps aiming at it
// while its rows settle: rows start at an estimated height and grow as they
// are measured, so one scroll can land anywhere. The frames here are run by
// hand, and the list is a stand-in whose layout each test sets.

function row(id: string): MessageListRow {
  const message = { id, parentID: 'ch-1', parentType: 'channel', authorID: 'u-1', body: id, createdAt: '' } as Message;
  return { kind: 'message', key: id, message, firstInGroup: true };
}
const ROWS = ['m-1', 'm-2', 'm-3'].map(row);

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
function runFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    const due = [...frames.entries()];
    frames.clear();
    act(() => {
      for (const [, callback] of due) callback(0);
    });
  }
}

// The list as the hook sees it: a 600px view, the linked row somewhere in or
// out of it (or not drawn at all), and how tall the content is.
type Layout = { row: 'in' | 'out' | 'missing'; height: number };
function makeScroller(layout: Layout) {
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'scrollHeight', { get: () => layout.height });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
  const anchored = document.createElement('div');
  anchored.dataset.messageId = 'm-3';
  anchored.getBoundingClientRect = () =>
    (layout.row === 'in' ? { top: 500, bottom: 540, height: 40 } : { top: 900, bottom: 940, height: 40 }) as DOMRect;
  const sync = () => {
    if (layout.row === 'missing') anchored.remove();
    else if (!anchored.isConnected) scroller.append(anchored);
  };
  sync();
  return { scroller, sync };
}

function setup(layout: Layout, { withScroller = true } = {}) {
  const scrollToIndex = vi.fn();
  const virtuosoRef = { current: { scrollToIndex } as unknown as VirtuosoHandle } as RefObject<VirtuosoHandle | null>;
  const { scroller, sync } = makeScroller(layout);
  document.body.append(scroller);
  const scrollerRef = { current: withScroller ? scroller : null } as RefObject<HTMLElement | null>;
  const hook = renderHook(
    ({ anchorMsgId }: { anchorMsgId?: string }) => useMessageListAnchor({ anchorMsgId, rows: ROWS, virtuosoRef, scrollerRef }),
    { initialProps: { anchorMsgId: 'm-3' as string | undefined } },
  );
  return { scrollToIndex, scrollerRef, scroller, sync, hook };
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('useMessageListAnchor settling on the linked message', () => {
  it('aims once and stops when the message is in view and the list has stopped growing', () => {
    const { scrollToIndex } = setup({ row: 'in', height: 1200 });
    runFrames(1);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, align: 'center' });
    // Three checks in a row with the message in view and the height steady.
    runFrames(2 * 4);
    expect(frames.size).toBe(0);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  // The flake on a loaded phone: the first aim ran before any row was
  // measured (a no-op), the rows then grew with the message out of view, and
  // nothing aimed again.
  it('aims again when the first scroll landed before the rows were laid out', () => {
    const layout: Layout = { row: 'missing', height: 600 };
    const { scrollToIndex, sync } = setup(layout);
    runFrames(1);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);

    // The rows are measured, taller: the message is drawn, below the view.
    layout.row = 'out';
    layout.height = 1652;
    sync();
    runFrames(2);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);

    // That aim brings it into view; the list settles there.
    layout.row = 'in';
    runFrames(2 * 4);
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
    expect(frames.size).toBe(0);
  });

  it('keeps checking while the list still grows under a message in view', () => {
    const layout: Layout = { row: 'in', height: 930 };
    const { scrollToIndex } = setup(layout);
    runFrames(1 + 2 * 2);
    layout.height = 1300;
    runFrames(2);
    layout.height = 1652;
    runFrames(2);
    // Still checking: the height has not been steady for three checks yet.
    expect(frames.size).toBeGreaterThan(0);
    runFrames(2 * 3);
    expect(frames.size).toBe(0);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('lets go as soon as the person scrolls', () => {
    const { scrollToIndex, hook } = setup({ row: 'out', height: 1652 });
    runFrames(1);
    hook.result.current.anchorHeldRef.current = false;
    runFrames(2);
    expect(frames.size).toBe(0);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of checks when the message never comes into view', () => {
    const { scrollToIndex } = setup({ row: 'out', height: 1652 });
    runFrames(1);
    runFrames(2 * 60);
    expect(frames.size).toBe(0);
    // The first aim, and one more after each check but the last.
    expect(scrollToIndex).toHaveBeenCalledTimes(40);
  });

  it('aims once and stops when there is no list to check against', () => {
    const { scrollToIndex } = setup({ row: 'out', height: 1652 }, { withScroller: false });
    runFrames(1 + 2 * 5);
    expect(frames.size).toBe(0);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('stops the pending check when the link goes away', () => {
    const { scrollToIndex, hook } = setup({ row: 'out', height: 1652 });
    runFrames(1);
    hook.rerender({ anchorMsgId: undefined });
    runFrames(2 * 5);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });
});
