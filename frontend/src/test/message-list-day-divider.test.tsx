import { describe, it, expect } from 'vitest';
import { buildMessageListRows } from '@/components/chat/MessageListRows';
import { formatDayHeading } from '@/lib/format';
import type { Message } from '@/types';

// Day-divider semantics live in the pure `buildMessageListRows`
// helper so they're covered without spinning up Virtuoso (which
// doesn't render items under jsdom). Heading rendering is verified
// by piping the divider's `date` field through `formatDayHeading`,
// the same call the component itself makes.

describe('MessageList day-grouping divider', () => {
  it('inserts one divider per calendar day spanned', () => {
    const messages: Message[] = [
      {
        id: 'm-1', parentID: 'ch-1', authorID: 'u-1', body: 'one',
        createdAt: new Date(2026, 3, 24, 10, 0, 0).toISOString(),
      },
      {
        id: 'm-2', parentID: 'ch-1', authorID: 'u-2', body: 'two',
        createdAt: new Date(2026, 3, 25, 11, 0, 0).toISOString(),
      },
      {
        id: 'm-3', parentID: 'ch-1', authorID: 'u-1', body: 'three',
        createdAt: new Date(2026, 3, 25, 14, 0, 0).toISOString(),
      },
    ];
    const rows = buildMessageListRows(messages);
    const dividers = rows.filter((r) => r.kind === 'day');
    expect(dividers).toHaveLength(2);
  });

  it('does not insert a divider between two messages on the same day', () => {
    const same1 = new Date(2026, 3, 26, 9, 0, 0);
    const same2 = new Date(2026, 3, 26, 18, 30, 0);
    const messages: Message[] = [
      {
        id: 'a', parentID: 'ch-1', authorID: 'u-1', body: 'morning',
        createdAt: same1.toISOString(),
      },
      {
        id: 'b', parentID: 'ch-1', authorID: 'u-2', body: 'evening',
        createdAt: same2.toISOString(),
      },
    ];
    const rows = buildMessageListRows(messages);
    expect(rows.filter((r) => r.kind === 'day')).toHaveLength(1);
  });

  it('renders the heading using the shared Mar 26th-style format', () => {
    const messages: Message[] = [
      {
        id: 'old', parentID: 'ch-1', authorID: 'u-1', body: 'old',
        createdAt: new Date(2025, 11, 31, 12, 0, 0).toISOString(),
      },
    ];
    const rows = buildMessageListRows(messages);
    const day = rows.find((r) => r.kind === 'day');
    expect(day).toBeDefined();
    if (day && day.kind === 'day') {
      // Older year → includes the year per formatDayHeading.
      expect(formatDayHeading(day.date)).toBe('Dec 31st, 2025');
    }
  });

  it('skips thread replies (they belong to the thread panel)', () => {
    const messages: Message[] = [
      {
        id: 'root', parentID: 'ch-1', authorID: 'u-1', body: 'root',
        createdAt: new Date(2026, 3, 26, 10, 0, 0).toISOString(),
      },
      {
        id: 'reply', parentID: 'ch-1', authorID: 'u-2', body: 'reply',
        parentMessageID: 'root',
        createdAt: new Date(2026, 3, 26, 11, 0, 0).toISOString(),
      },
    ];
    const rows = buildMessageListRows(messages);
    const messageRows = rows.filter((r) => r.kind === 'message');
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0].kind === 'message' && messageRows[0].message.id).toBe('root');
  });
});
