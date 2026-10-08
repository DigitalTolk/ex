import { describe, expect, it } from 'vitest';
import { countsTowardUnread, resolveUnreadDivider, unreadFrom } from './unread-divider';
import type { Message } from '@/types';

const msg = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  parentID: 'p',
  authorID: 'u',
  body: id,
  createdAt: `2026-10-07T09:00:0${id.slice(-1)}Z`,
  ...over,
});

describe('countsTowardUnread', () => {
  it('mirrors the server counter: top-level, and in a channel not a system notice', () => {
    expect(countsTowardUnread(msg('m1'), 'channel')).toBe(true);
    expect(countsTowardUnread(msg('m1', { system: true }), 'channel')).toBe(false);
    expect(countsTowardUnread(msg('m1', { system: true }), 'conversation')).toBe(true);
    expect(countsTowardUnread(msg('m1', { parentMessageID: 'root' }), 'conversation')).toBe(false);
    expect(countsTowardUnread(msg('m1', { deleted: true }), 'channel')).toBe(true);
  });
});

describe('resolveUnreadDivider', () => {
  const messages = [msg('m1'), msg('m2', { system: true }), msg('m3'), msg('m4')];

  it('finds an exact message, or null when it is not loaded', () => {
    expect(resolveUnreadDivider({ kind: 'message', messageID: 'm3' }, messages, 'channel')).toBe('m3');
    expect(resolveUnreadDivider({ kind: 'message', messageID: 'gone' }, messages, 'channel')).toBeNull();
  });

  it('counts back over counted messages only, null when the count runs past the loaded ones', () => {
    // channel: m2 is a system notice, so 3 counted = m4, m3, m1
    expect(resolveUnreadDivider({ kind: 'count', count: 3 }, messages, 'channel')).toBe('m1');
    expect(resolveUnreadDivider({ kind: 'count', count: 3 }, messages, 'conversation')).toBe('m2');
    expect(resolveUnreadDivider({ kind: 'count', count: 9 }, messages, 'channel')).toBeNull();
  });

  it('threads: the first reply after the seen time, null when nothing is newer', () => {
    expect(resolveUnreadDivider({ kind: 'after', at: '2026-10-07T09:00:02Z' }, messages, 'channel')).toBe('m3');
    expect(resolveUnreadDivider({ kind: 'after', at: '2026-10-07T10:00:00Z' }, messages, 'channel')).toBeNull();
  });
});

describe('unreadFrom', () => {
  it('counts the counted messages from the line to the end', () => {
    const messages = [msg('m1'), msg('m2', { system: true }), msg('m3')];
    expect(unreadFrom(messages, 'm1', 'channel')).toBe(2);
    expect(unreadFrom(messages, 'm1', 'conversation')).toBe(3);
    expect(unreadFrom(messages, 'nope', 'channel')).toBe(0);
  });
});
