import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  countUnreadAfter,
  countUnreadFrom,
  findUnreadDivider,
  isCountedUnread,
  maxId,
  newestReadPointId,
  sinceLabel,
} from './unread-marker';

function m(id: string, overrides: Partial<Message> = {}): Message {
  return { id, parentID: 'p1', authorID: 'other', body: id, createdAt: '2026-09-24T10:00:00Z', ...overrides } as Message;
}

describe('isCountedUnread', () => {
  it('counts top-level, non-system messages from others', () => {
    expect(isCountedUnread(m('01A'), 'me')).toBe(true);
    expect(isCountedUnread(m('01A', { authorID: 'me' }), 'me')).toBe(false);
    expect(isCountedUnread(m('01A', { parentMessageID: 'root' }), 'me')).toBe(false);
    expect(isCountedUnread(m('01A', { system: true }), 'me')).toBe(false);
    // A webhook the viewer created is still "new" to them.
    expect(isCountedUnread(m('01A', { authorID: 'me', webhookUsername: 'bot' }), 'me')).toBe(true);
  });
});

describe('newestReadPointId', () => {
  it('returns the newest top-level non-system message (own included)', () => {
    expect(newestReadPointId([m('01A'), m('01B', { authorID: 'me' }), m('01C', { system: true }), m('01D', { parentMessageID: 'x' })])).toBe('01B');
    expect(newestReadPointId([])).toBeUndefined();
  });
});

describe('findUnreadDivider', () => {
  const base = { currentUserId: 'me', fallbackCount: 0, hasOlderPages: false };

  it('places it at the first counted message after the watermark', () => {
    const messages = [m('01A'), m('01B', { authorID: 'me' }), m('01C'), m('01D')];
    expect(findUnreadDivider({ ...base, messages, watermark: '01B' })).toEqual({ id: '01C', certain: true });
  });

  it('is certain even with older pages once the window reaches the read point', () => {
    const messages = [m('01A'), m('01C')];
    expect(findUnreadDivider({ ...base, messages, watermark: '01B', hasOlderPages: true })).toEqual({ id: '01C', certain: true });
  });

  it('is provisional when older pages may still hold unread', () => {
    const messages = [m('01C'), m('01D')];
    expect(findUnreadDivider({ ...base, messages, watermark: '01B', hasOlderPages: true })).toEqual({ id: '01C', certain: false });
  });

  it('nothing after the watermark → certain, no divider', () => {
    expect(findUnreadDivider({ ...base, messages: [m('01A')], watermark: '01Z' })).toEqual({ certain: true });
    expect(findUnreadDivider({ ...base, messages: [], watermark: '01Z', hasOlderPages: true })).toEqual({ certain: true });
  });

  it('falls back to counting back from the newest when there is no watermark', () => {
    const messages = [m('01A'), m('01B'), m('01C')];
    expect(findUnreadDivider({ ...base, messages, fallbackCount: 2 })).toEqual({ id: '01B', certain: true });
    expect(findUnreadDivider({ ...base, messages, fallbackCount: 0 })).toEqual({ certain: true });
  });

  it('fallback count beyond the loaded window is provisional while older pages exist', () => {
    const messages = [m('01B'), m('01C')];
    expect(findUnreadDivider({ ...base, messages, fallbackCount: 5, hasOlderPages: true })).toEqual({ id: '01B', certain: false });
    expect(findUnreadDivider({ ...base, messages, fallbackCount: 5 })).toEqual({ id: '01B', certain: true });
    expect(findUnreadDivider({ ...base, messages: [], fallbackCount: 5 })).toEqual({ id: undefined, certain: true });
  });
});

describe('counts', () => {
  const messages = [m('01A'), m('01B', { authorID: 'me' }), m('01C'), m('01D', { system: true }), m('01E')];

  it('countUnreadFrom counts counted messages from the divider on', () => {
    expect(countUnreadFrom(messages, '01C', 'me')).toBe(2);
  });

  it('countUnreadAfter counts counted messages after the read point', () => {
    expect(countUnreadAfter(messages, '01C', 'me')).toBe(1);
    expect(countUnreadAfter(messages, undefined, 'me')).toBe(0);
  });
});

describe('maxId', () => {
  it('returns the later of two optional IDs', () => {
    expect(maxId(undefined, '01A')).toBe('01A');
    expect(maxId('01A', undefined)).toBe('01A');
    expect(maxId('01A', '01B')).toBe('01B');
    expect(maxId('01C', '01B')).toBe('01C');
  });
});

describe('sinceLabel', () => {
  const now = new Date(2026, 8, 24, 16, 0);

  it('is empty without a timestamp', () => {
    expect(sinceLabel(undefined, now)).toBe('');
  });

  it('shows the time for today', () => {
    const at = new Date(2026, 8, 24, 15, 7);
    const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(sinceLabel(at.toISOString(), now)).toBe(` since ${time}`);
  });

  it('shows the day for older messages', () => {
    expect(sinceLabel(new Date(2026, 8, 23, 9, 0).toISOString(), now)).toBe(' since Yesterday');
  });
});
