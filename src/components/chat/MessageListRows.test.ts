import { describe, expect, it } from 'vitest';
import { isGroupedWithPrevious } from './MessageListRows';
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

describe('buildMessageListRows — the "New messages" line', () => {
  it('goes directly above the first unread message, below its day divider, and starts a fresh group', async () => {
    const { buildMessageListRows, UNREAD_DIVIDER_KEY } = await import('./MessageListRows');
    const a = at('a', '2026-10-07T09:00:00Z', { authorID: 'u-1' });
    const b = at('b', '2026-10-07T09:01:00Z', { authorID: 'u-1' });
    const c = at('c', '2026-10-08T09:00:00Z', { authorID: 'u-1' });
    const plain = buildMessageListRows([a, b]);
    expect(plain.map((r) => r.key)).toEqual([expect.stringMatching(/^day-/), 'a', 'b']);
    expect(plain[2]).toMatchObject({ firstInGroup: false });

    const withLine = buildMessageListRows([a, b], 'b');
    expect(withLine.map((r) => r.kind)).toEqual(['day', 'message', 'unread', 'message']);
    expect(withLine[2].key).toBe(UNREAD_DIVIDER_KEY);
    expect(withLine[3]).toMatchObject({ key: 'b', firstInGroup: true });

    const nextDay = buildMessageListRows([a, c], 'c');
    expect(nextDay.map((r) => r.kind)).toEqual(['day', 'message', 'day', 'unread', 'message']);
  });
});
