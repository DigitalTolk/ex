import { describe, it, expect } from 'vitest';
import {
  buildMessageListRows,
  nextVirtuosoState,
  type VirtuosoStateTransition,
} from '@/components/chat/MessageListRows';
import type { Message } from '@/types';

// `nextVirtuosoState` is the contract between React Query's `pages`
// and Virtuoso's `firstItemIndex`+`data` props. Virtuoso requires
// the two to update atomically on prepend; this helper computes the
// next pair from the previous state and the new row list. The tests
// below model the actual sequence of transitions a chat session
// goes through — initial mount, append (live message / own send),
// prepend (older-page fetch), and edits — and verify the invariants
// Virtuoso depends on.

const START = 1_000_000;

function msg(overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  return {
    parentID: 'ch-1',
    authorID: 'u-1',
    body: '',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

function step(
  prev: VirtuosoStateTransition,
  messages: Message[],
): VirtuosoStateTransition {
  return nextVirtuosoState(prev, buildMessageListRows(messages));
}

describe('nextVirtuosoState (Virtuoso prepend bridge)', () => {
  it('initial population: 0 → N rows leaves firstItemIndex at the start value', () => {
    const initial: VirtuosoStateTransition = { rows: [], firstItemIndex: START };
    const after = step(initial, [
      msg({ id: 'm-1' }),
      msg({ id: 'm-2' }),
      msg({ id: 'm-3' }),
    ]);
    expect(after.firstItemIndex).toBe(START);
    expect(after.rows.filter((r) => r.kind === 'message')).toHaveLength(3);
  });

  it('append: live message arriving at the bottom does not shift firstItemIndex', () => {
    const initial: VirtuosoStateTransition = { rows: [], firstItemIndex: START };
    const seeded = step(initial, [
      msg({ id: 'm-1', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'm-2', createdAt: '2026-04-24T10:01:00Z' }),
    ]);
    const after = step(seeded, [
      msg({ id: 'm-1', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'm-2', createdAt: '2026-04-24T10:01:00Z' }),
      msg({ id: 'm-3', createdAt: '2026-04-24T10:02:00Z' }),
    ]);
    expect(after.firstItemIndex).toBe(START);
  });

  it('prepend: older-page fetch shifts firstItemIndex down by the new-row count', () => {
    const initial: VirtuosoStateTransition = { rows: [], firstItemIndex: START };
    const seeded = step(initial, [
      msg({ id: 'm-3', createdAt: '2026-04-24T10:02:00Z' }),
      msg({ id: 'm-4', createdAt: '2026-04-24T10:03:00Z' }),
    ]);
    expect(seeded.firstItemIndex).toBe(START);
    // Older fetch returns m-1, m-2; rows now m-1, m-2, m-3, m-4 (2
    // new at front).
    const after = step(seeded, [
      msg({ id: 'm-1', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'm-2', createdAt: '2026-04-24T10:01:00Z' }),
      msg({ id: 'm-3', createdAt: '2026-04-24T10:02:00Z' }),
      msg({ id: 'm-4', createdAt: '2026-04-24T10:03:00Z' }),
    ]);
    expect(after.firstItemIndex).toBe(START - 2);
  });

  it('successive prepends accumulate the firstItemIndex shift', () => {
    // Regression for the "scrolling stops before reaching oldest"
    // bug: after the first prepend, subsequent prepends were
    // computing the shift against stale state and Virtuoso's
    // `startReached` stopped firing. Each transition must shift
    // exclusively by the delta, never repeating prior shifts.
    let s: VirtuosoStateTransition = { rows: [], firstItemIndex: START };
    s = step(s, [msg({ id: 'm-50', createdAt: '2026-04-24T11:00:00Z' })]);
    expect(s.firstItemIndex).toBe(START);

    // First prepend: 5 older messages.
    s = step(s, [
      ...Array.from({ length: 5 }, (_, i) =>
        msg({ id: `m-old-1-${i}`, createdAt: `2026-04-24T10:0${i}:00Z` }),
      ),
      msg({ id: 'm-50', createdAt: '2026-04-24T11:00:00Z' }),
    ]);
    expect(s.firstItemIndex).toBe(START - 5);

    // Second prepend: 7 even older.
    s = step(s, [
      ...Array.from({ length: 7 }, (_, i) =>
        msg({ id: `m-old-2-${i}`, createdAt: `2026-04-24T09:0${i}:00Z` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        msg({ id: `m-old-1-${i}`, createdAt: `2026-04-24T10:0${i}:00Z` }),
      ),
      msg({ id: 'm-50', createdAt: '2026-04-24T11:00:00Z' }),
    ]);
    expect(s.firstItemIndex).toBe(START - 12);

    // Third prepend: 3 more.
    s = step(s, [
      ...Array.from({ length: 3 }, (_, i) =>
        msg({ id: `m-old-3-${i}`, createdAt: `2026-04-24T08:0${i}:00Z` }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        msg({ id: `m-old-2-${i}`, createdAt: `2026-04-24T09:0${i}:00Z` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        msg({ id: `m-old-1-${i}`, createdAt: `2026-04-24T10:0${i}:00Z` }),
      ),
      msg({ id: 'm-50', createdAt: '2026-04-24T11:00:00Z' }),
    ]);
    expect(s.firstItemIndex).toBe(START - 15);
  });

  it('edit: same first key, same length leaves firstItemIndex untouched', () => {
    let s: VirtuosoStateTransition = { rows: [], firstItemIndex: START };
    s = step(s, [
      msg({ id: 'm-1', body: 'hello', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'm-2', body: 'world', createdAt: '2026-04-24T10:01:00Z' }),
    ]);
    const before = s.firstItemIndex;
    s = step(s, [
      msg({ id: 'm-1', body: 'edited', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'm-2', body: 'world', createdAt: '2026-04-24T10:01:00Z' }),
    ]);
    expect(s.firstItemIndex).toBe(before);
  });

  it('returns the same prev reference when rows are identity-equal (skips needless setState)', () => {
    const rows = buildMessageListRows([msg({ id: 'm-1' })]);
    const prev: VirtuosoStateTransition = { rows, firstItemIndex: START };
    expect(nextVirtuosoState(prev, rows)).toBe(prev);
  });

  it('append-then-prepend preserves the firstItemIndex shift on the prepend leg only', () => {
    // Verifies the order-sensitivity: append must NOT shift, prepend
    // MUST shift, even if both happen between two consecutive states.
    let s: VirtuosoStateTransition = { rows: [], firstItemIndex: START };
    s = step(s, [
      msg({ id: 'a', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'b', createdAt: '2026-04-24T10:01:00Z' }),
    ]);
    // Append c at the bottom (new live message).
    s = step(s, [
      msg({ id: 'a', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'b', createdAt: '2026-04-24T10:01:00Z' }),
      msg({ id: 'c', createdAt: '2026-04-24T10:02:00Z' }),
    ]);
    expect(s.firstItemIndex).toBe(START);
    // Prepend two older.
    s = step(s, [
      msg({ id: 'old-1', createdAt: '2026-04-24T09:00:00Z' }),
      msg({ id: 'old-2', createdAt: '2026-04-24T09:01:00Z' }),
      msg({ id: 'a', createdAt: '2026-04-24T10:00:00Z' }),
      msg({ id: 'b', createdAt: '2026-04-24T10:01:00Z' }),
      msg({ id: 'c', createdAt: '2026-04-24T10:02:00Z' }),
    ]);
    expect(s.firstItemIndex).toBe(START - 2);
  });
});
