import { describe, expect, it } from 'vitest';
import { buildMessageListRows, isGroupedWithPrevious, nextVirtuosoState, type MessageListRow } from './MessageListRows';
import type { Message } from '@/types';

function msg(id: string, createdAt: string, parentMessageID?: string): Message {
  return {
    id,
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: id,
    createdAt,
    ...(parentMessageID ? { parentMessageID } : {}),
  };
}

describe('buildMessageListRows (browser)', () => {
  it('inserts a day divider per calendar day and skips thread replies', () => {
    const rows = buildMessageListRows([
      msg('m1', '2026-05-01T10:00:00Z'),
      msg('m2', '2026-05-01T11:00:00Z'),
      msg('reply', '2026-05-01T11:30:00Z', 'm1'), // thread reply → skipped
      msg('m3', '2026-05-02T09:00:00Z'),
    ]);
    const kinds = rows.map((r) => r.kind);
    // day, m1, m2, day, m3 — reply omitted.
    expect(kinds).toEqual(['day', 'message', 'message', 'day', 'message']);
    expect(rows.filter((r) => r.kind === 'message').map((r) => (r.kind === 'message' ? r.message.id : '')))
      .toEqual(['m1', 'm2', 'm3']);
  });

  it('returns an empty list for no messages', () => {
    expect(buildMessageListRows([])).toEqual([]);
  });

  it('groups consecutive same-author messages within the time window', () => {
    const rows = buildMessageListRows([
      msg('m1', '2026-05-01T10:00:00Z'),
      msg('m2', '2026-05-01T10:02:00Z'), // +2m, same author → grouped
      msg('m3', '2026-05-01T10:10:00Z'), // +8m → new group
    ]);
    const flags = rows
      .filter((r) => r.kind === 'message')
      .map((r) => (r.kind === 'message' ? r.firstInGroup : null));
    expect(flags).toEqual([true, false, true]);
  });

  it('starts a fresh group after a day divider', () => {
    // Straddle LOCAL midnight (dayKey uses local time) so the two messages
    // land on different calendar days while staying inside the 5-min group
    // window — proving the day divider, not the time gap, breaks the group.
    const localMidnight = new Date(2026, 4, 2, 0, 0, 0);
    const before = new Date(localMidnight.getTime() - 60_000).toISOString();
    const after = new Date(localMidnight.getTime() + 60_000).toISOString();
    const rows = buildMessageListRows([msg('m1', before), msg('m2', after)]);
    const m2 = rows.find((r) => r.kind === 'message' && r.message.id === 'm2');
    expect(m2?.kind === 'message' && m2.firstInGroup).toBe(true);
  });
});

describe('isGroupedWithPrevious (browser)', () => {
  function at(id: string, createdAt: string, over: Partial<Message> = {}): Message {
    return { id, parentID: 'ch-1', authorID: 'u-1', body: id, createdAt, ...over };
  }

  it('groups same author within the window', () => {
    expect(isGroupedWithPrevious(at('a', '2026-05-01T10:00:00Z'), at('b', '2026-05-01T10:04:00Z'))).toBe(true);
  });
  it('does not group across the time window', () => {
    expect(isGroupedWithPrevious(at('a', '2026-05-01T10:00:00Z'), at('b', '2026-05-01T10:06:00Z'))).toBe(false);
  });
  it('does not group with no previous message', () => {
    expect(isGroupedWithPrevious(null, at('b', '2026-05-01T10:00:00Z'))).toBe(false);
  });
  it('does not group different authors', () => {
    expect(
      isGroupedWithPrevious(at('a', '2026-05-01T10:00:00Z'), at('b', '2026-05-01T10:01:00Z', { authorID: 'u-2' })),
    ).toBe(false);
  });
  it('does not group a system message or after one', () => {
    expect(isGroupedWithPrevious(at('a', '2026-05-01T10:00:00Z'), at('b', '2026-05-01T10:01:00Z', { system: true }))).toBe(false);
    expect(isGroupedWithPrevious(at('a', '2026-05-01T10:00:00Z', { system: true }), at('b', '2026-05-01T10:01:00Z'))).toBe(false);
  });
  it('does not group distinct webhook identities', () => {
    expect(
      isGroupedWithPrevious(
        at('a', '2026-05-01T10:00:00Z', { webhookUsername: 'Deploy' }),
        at('b', '2026-05-01T10:01:00Z', { webhookUsername: 'Alerts' }),
      ),
    ).toBe(false);
  });
  it('does not group when the next message predates the previous (clock skew)', () => {
    expect(isGroupedWithPrevious(at('a', '2026-05-01T10:05:00Z'), at('b', '2026-05-01T10:00:00Z'))).toBe(false);
  });
});

describe('nextVirtuosoState (browser)', () => {
  const rowsA = buildMessageListRows([msg('m2', '2026-05-01T11:00:00Z')]);
  const rowsPrepended = buildMessageListRows([
    msg('m1', '2026-05-01T10:00:00Z'),
    msg('m2', '2026-05-01T11:00:00Z'),
  ]);
  const rowsAppended = buildMessageListRows([
    msg('m2', '2026-05-01T11:00:00Z'),
    msg('m3', '2026-05-01T12:00:00Z'),
  ]);

  it('returns the previous state unchanged when the rows reference is identical', () => {
    const prev = { rows: rowsA, firstItemIndex: 1000 };
    expect(nextVirtuosoState(prev, rowsA)).toBe(prev);
  });

  it('keeps firstItemIndex when starting from an empty list', () => {
    const prev = { rows: [] as ReturnType<typeof buildMessageListRows>, firstItemIndex: 1000 };
    const next = nextVirtuosoState(prev, rowsA);
    expect(next.firstItemIndex).toBe(1000);
  });

  it('keeps firstItemIndex on an append-only update', () => {
    const prev = { rows: rowsA, firstItemIndex: 1000 };
    const next = nextVirtuosoState(prev, rowsAppended);
    // First message (m2) unchanged → append → index stable.
    expect(next.firstItemIndex).toBe(1000);
  });

  it('shifts firstItemIndex down by the prepend count when older messages arrive', () => {
    const prev = { rows: rowsA, firstItemIndex: 1000 };
    const next = nextVirtuosoState(prev, rowsPrepended);
    // Two rows added (day divider + m1) and first message changed → prepend.
    expect(next.firstItemIndex).toBe(1000 - (rowsPrepended.length - rowsA.length));
  });

  it('keeps firstItemIndex when the new list is not longer', () => {
    const prev = { rows: rowsPrepended, firstItemIndex: 1000 };
    const next = nextVirtuosoState(prev, rowsA);
    expect(next.firstItemIndex).toBe(1000);
  });

  it('treats a growth with no message rows on either side as an append (no first message to compare)', () => {
    // Divider-only row lists: firstMessageId finds no message row and returns
    // undefined for both sides — equal → append path, index stays put.
    const dayOnly: MessageListRow[] = [
      { kind: 'day', key: 'day-2026-05-01', date: '2026-05-01T00:00:00Z' },
    ];
    const dayOnlyGrown: MessageListRow[] = [
      ...dayOnly,
      { kind: 'day', key: 'day-2026-05-02', date: '2026-05-02T00:00:00Z' },
    ];
    const prev = { rows: dayOnly, firstItemIndex: 1000 };
    const next = nextVirtuosoState(prev, dayOnlyGrown);
    expect(next.firstItemIndex).toBe(1000);
    expect(next.rows).toBe(dayOnlyGrown);
  });
});
