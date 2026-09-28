import { describe, expect, it } from 'vitest';
import { buildMessageListRows, isGroupedWithPrevious, nextVirtuosoState, UNREAD_DIVIDER_KEY } from './MessageListRows';
import type { Message } from '@/types';

// jsdom twin of the browser-suite grouping tests: pins the webhook-identity
// arm (distinct bot usernames under the shared webhook author never group).

function at(id: string, createdAt: string, over: Partial<Message> = {}): Message {
  return { id, parentID: 'ch-1', authorID: 'webhook', body: id, createdAt, ...over } as Message;
}

describe('isGroupedWithPrevious — webhook identities', () => {
  it('keeps distinct webhook usernames as separate groups', () => {
    expect(
      isGroupedWithPrevious(
        at('a', '2026-05-01T10:00:00Z', { webhookUsername: 'CI Bot' }),
        at('b', '2026-05-01T10:01:00Z', { webhookUsername: 'Alerts' }),
      ),
    ).toBe(false);
  });

  it('groups consecutive posts from the same webhook identity', () => {
    expect(
      isGroupedWithPrevious(
        at('a', '2026-05-01T10:00:00Z', { webhookUsername: 'CI Bot' }),
        at('b', '2026-05-01T10:01:00Z', { webhookUsername: 'CI Bot' }),
      ),
    ).toBe(true);
  });
});

describe('buildMessageListRows — unread divider', () => {
  const at = (id: string, createdAt: string, authorID = 'u1'): Message =>
    ({ id, parentID: 'p', authorID, body: id, createdAt } as Message);

  it('inserts the New divider above the first unread and resets grouping', () => {
    const rows = buildMessageListRows(
      [at('01A', '2026-09-24T10:00:00Z'), at('01B', '2026-09-24T10:01:00Z'), at('01C', '2026-09-24T10:02:00Z')],
      '01B',
    );
    expect(rows.map((r) => r.key)).toEqual([rows[0].key, '01A', UNREAD_DIVIDER_KEY, '01B', '01C']);
    const first = rows[3];
    expect(first.kind === 'message' && first.firstInGroup).toBe(true);
  });

  it('puts the divider below the day divider when the unread opens a new day', () => {
    const rows = buildMessageListRows(
      [at('01A', '2026-09-23T10:00:00Z'), at('01B', '2026-09-24T10:00:00Z')],
      '01B',
    );
    expect(rows.map((r) => r.kind)).toEqual(['day', 'message', 'day', 'unread', 'message']);
  });

  it('omits the divider when none is set', () => {
    const rows = buildMessageListRows([at('01A', '2026-09-24T10:00:00Z')]);
    expect(rows.some((r) => r.kind === 'unread')).toBe(false);
  });
});

describe('nextVirtuosoState — prepend shift', () => {
  const at = (id: string, createdAt: string): Message =>
    ({ id, parentID: 'p', authorID: 'u1', body: id, createdAt } as Message);
  const day = '2026-09-24T10:0';

  it('shifts by how far the old first message moved, not by total growth', () => {
    const prevRows = buildMessageListRows([at('01C', `${day}3:00Z`), at('01D', `${day}4:00Z`)]);
    const prev = { rows: prevRows, firstItemIndex: 1000 };
    // An older page prepends two messages AND the unread divider lands
    // mid-list in the same update: growth is 3 rows, the true prepend is 2.
    const rows = buildMessageListRows(
      [at('01A', `${day}1:00Z`), at('01B', `${day}2:00Z`), at('01C', `${day}3:00Z`), at('01D', `${day}4:00Z`)],
      '01D',
    );
    expect(nextVirtuosoState(prev, rows).firstItemIndex).toBe(998);
  });

  it('falls back to the growth when the old first message is gone', () => {
    const prev = { rows: buildMessageListRows([at('01C', `${day}3:00Z`)]), firstItemIndex: 1000 };
    const rows = buildMessageListRows([at('01A', `${day}1:00Z`), at('01B', `${day}2:00Z`)]);
    expect(nextVirtuosoState(prev, rows).firstItemIndex).toBe(999);
  });
});
