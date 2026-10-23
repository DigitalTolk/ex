import { describe, expect, it } from 'vitest';
import { messageRowPropsEqual, type MessageRowProps } from './message-row-equal';
import type { Message } from '@/types';

// A row skips re-rendering only when nothing it shows changed: the message,
// its grouping, its thread summary, or any other prop.

const message = { id: 'm-1', body: 'hi', authorID: 'u-1', parentID: 'ch-1', createdAt: '2026-10-07T09:00:00Z' } as Message;

const userMap = {};
const userLookup = { get: () => undefined };

function props(over: Partial<MessageRowProps> = {}): MessageRowProps {
  return {
    row: { kind: 'message', key: 'm-1', message, firstInGroup: true },
    userMap,
    userLookup,
    threadMetaEntry: { lastReplyAt: '2026-10-07T10:00:00Z', authors: ['u-2', 'u-3'] },
    ...over,
  };
}

describe('messageRowPropsEqual', () => {
  it('holds when a rebuilt row and thread summary say the same', () => {
    const prev = props();
    const next = props({
      row: { ...prev.row },
      threadMetaEntry: { lastReplyAt: '2026-10-07T10:00:00Z', authors: ['u-2', 'u-3'] },
    });
    expect(messageRowPropsEqual(prev, next)).toBe(true);
    expect(messageRowPropsEqual(prev, prev)).toBe(true);
  });

  it('re-renders for a changed message, key or grouping', () => {
    const prev = props();
    expect(messageRowPropsEqual(prev, props({ row: { ...prev.row, message: { ...message } } }))).toBe(false);
    expect(messageRowPropsEqual(prev, props({ row: { ...prev.row, key: 'm-2' } }))).toBe(false);
    expect(messageRowPropsEqual(prev, props({ row: { ...prev.row, firstInGroup: false } }))).toBe(false);
  });

  // Replies that land in the loaded history change the root's summary while
  // the root message itself stays the same object.
  it('re-renders when the thread summary changes', () => {
    const prev = props();
    const meta = (lastReplyAt: string, authors: string[]) => props({ row: prev.row, threadMetaEntry: { lastReplyAt, authors } });
    expect(messageRowPropsEqual(props({ threadMetaEntry: undefined }), prev)).toBe(false);
    expect(messageRowPropsEqual(prev, props({ row: prev.row, threadMetaEntry: undefined }))).toBe(false);
    expect(messageRowPropsEqual(prev, meta('2026-10-07T11:00:00Z', ['u-2', 'u-3']))).toBe(false);
    expect(messageRowPropsEqual(prev, meta('2026-10-07T10:00:00Z', ['u-2', 'u-3', 'u-4']))).toBe(false);
    expect(messageRowPropsEqual(prev, meta('2026-10-07T10:00:00Z', ['u-2', 'u-4']))).toBe(false);
  });

  it('re-renders for any other changed prop', () => {
    const prev = props();
    expect(messageRowPropsEqual(prev, props({ row: prev.row, threadMetaEntry: prev.threadMetaEntry, highlighted: true }))).toBe(false);
  });
});
