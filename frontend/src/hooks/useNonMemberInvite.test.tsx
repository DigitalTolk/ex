import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

let mockMembers: { userID: string }[] | undefined;
let mockUserChannels: { channelID: string; channelName: string }[] | undefined;

vi.mock('@/hooks/useChannels', () => ({
  useChannelMembers: () => ({ data: mockMembers }),
  useUserChannels: () => ({ data: mockUserChannels }),
}));

import { useNonMemberInvite } from './useNonMemberInvite';

// @[id|name] mention helper to keep the bodies readable.
const m = (id: string, name: string) => `@[${id}|${name}]`;

beforeEach(() => {
  mockMembers = [{ userID: 'me' }, { userID: 'in' }];
  mockUserChannels = [{ channelID: 'ch-1', channelName: 'General Chat' }];
});

describe('useNonMemberInvite', () => {
  it('surfaces mentioned non-members and derives the channel slug', () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'));
    expect(result.current.channelSlug).toBe('general-chat');
    expect(result.current.pendingInvites).toEqual([]);

    act(() => result.current.checkMentions(`hi ${m('out', 'Outsider')} and ${m('in', 'Insider')}`));
    expect(result.current.pendingInvites).toEqual([{ id: 'out', displayName: 'Outsider' }]);
  });

  it('skips the author and clears on demand', () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'));
    act(() => result.current.checkMentions(`${m('me', 'Me')} ${m('out', 'Outsider')}`));
    expect(result.current.pendingInvites).toEqual([{ id: 'out', displayName: 'Outsider' }]);

    act(() => result.current.clearInvites());
    expect(result.current.pendingInvites).toEqual([]);
  });

  it('is a no-op for conversation threads (no channelId)', () => {
    const { result } = renderHook(() => useNonMemberInvite(undefined, 'me'));
    expect(result.current.channelSlug).toBe('');
    act(() => result.current.checkMentions(`hi ${m('out', 'Outsider')}`));
    expect(result.current.pendingInvites).toEqual([]);
  });

  it('falls back to an empty slug when the channel is unknown', () => {
    mockUserChannels = [];
    const { result } = renderHook(() => useNonMemberInvite('ch-unknown', undefined));
    expect(result.current.channelSlug).toBe('');
  });
});
