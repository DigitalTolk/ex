import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSearchModifiers } from './useSearchModifiers';

const people = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const channels = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const conversations = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
vi.mock('@/hooks/useConversations', () => ({
  useAllUsers: () => people,
  useUserConversations: () => conversations,
}));
vi.mock('@/hooks/useChannels', () => ({ useUserChannels: () => channels }));

beforeEach(() => {
  Object.assign(people, { data: [{ id: 'u-g', displayName: 'Günter Weber', email: 'gw@example.com' }], isLoading: false });
  Object.assign(channels, { data: [{ channelID: 'c-ops', channelName: 'ops' }], isLoading: false });
  Object.assign(conversations, { data: [{ conversationID: 'd-1', displayName: 'Ada Lovelace' }], isLoading: false });
});

const run = (q: string) => renderHook(() => useSearchModifiers(q)).result.current;

describe('useSearchModifiers', () => {
  it('is just the words for a search without modifiers', () => {
    expect(run('  datadog  ')).toEqual({ text: 'datadog', pending: false, dates: [] });
  });

  it('resolves from: to a person and in: to a channel or a DM', () => {
    expect(run('datadog from:gunter in:~ops')).toEqual({ text: 'datadog', fromID: 'u-g', inID: 'c-ops', pending: false, dates: [] });
    expect(run('in:"ada lovelace"').inID).toBe('d-1');
  });

  it('waits for the lists a modifier needs', () => {
    people.isLoading = true;
    expect(run('from:gunter')).toEqual({ text: '', pending: true, dates: [] });
    people.isLoading = false;
    conversations.isLoading = true;
    expect(run('in:ops').pending).toBe(true);
    expect(run('datadog').pending).toBe(false);
  });

  it('turns on:, after: and before: into the instants of the reader\'s days', () => {
    const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();
    expect(run('deploy on:2026-11-20')).toMatchObject({
      text: 'deploy',
      after: day(2026, 11, 20),
      before: day(2026, 11, 21),
      dates: [{ key: 'on', value: '2026-11-20' }],
    });
    const span = run('after:2026-11-01 before:2026-11-10');
    expect([span.after, span.before]).toEqual([day(2026, 11, 2), day(2026, 11, 10)]);
    expect(span.dates.map((d) => d.key)).toEqual(['after', 'before']);
    expect(run('x on:someday')).toMatchObject({ unmatched: 'on:someday' });
    // A name that matches no one is named first.
    expect(run('from:nobody on:someday').unmatched).toBe('from:nobody');
  });

  it('names the first modifier that matches nothing', () => {
    expect(run('x from:nobody in:nowhere').unmatched).toBe('from:nobody');
    expect(run('x in:nowhere').unmatched).toBe('in:nowhere');
    people.data = undefined;
    channels.data = undefined;
    conversations.data = undefined;
    expect(run('from:gunter').unmatched).toBe('from:gunter');
    expect(run('in:ops').unmatched).toBe('in:ops');
  });
});
