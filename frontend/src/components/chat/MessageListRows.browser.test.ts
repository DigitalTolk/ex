import { describe, expect, it } from 'vitest';
import { buildMessageListRows, nextVirtuosoState } from './MessageListRows';
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
});
