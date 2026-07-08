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
