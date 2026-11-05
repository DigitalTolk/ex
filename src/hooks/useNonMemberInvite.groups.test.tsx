import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryKeys } from '@/lib/query-keys';

let mockMembers: { userID: string }[] | undefined;
let mockUserChannels: { channelID: string; channelName: string; channelType: string }[] | undefined;

vi.mock('@/hooks/useChannels', () => ({
  useChannelMembers: () => ({ data: mockMembers }),
  useUserChannels: (opts?: { select?: (rows: never[]) => unknown }) => {
    const rows = mockUserChannels as never[];
    return { data: opts?.select && rows ? opts.select(rows) : rows };
  },
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import { useNonMemberInvite } from './useNonMemberInvite';

const GROUPS: Record<string, unknown> = {
  '/api/v1/usergroups/group-oncall': { id: 'group-oncall', handle: 'oncall', disabled: false, memberIds: ['me', 'in', 'out1', 'out2', 'gone'] },
  '/api/v1/usergroups/group-off': { id: 'group-off', handle: 'off', disabled: true, memberIds: ['out3'] },
  // A detail without a member list reads as an empty group.
  '/api/v1/usergroups/group-empty': { id: 'group-empty', handle: 'empty', disabled: false },
};

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockMembers = [{ userID: 'me' }, { userID: 'in' }];
  mockUserChannels = [{ channelID: 'ch-1', channelName: 'alerts', channelType: 'private' }];
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(queryKeys.allUsers(), [{ id: 'gone', status: 'deactivated' }, { id: 'out1', status: 'active' }]);
  qc.setQueryData(queryKeys.userGroups(false), [{ id: 'group-oncall', handle: 'oncall' }]);
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string) =>
    path in GROUPS ? Promise.resolve(GROUPS[path]) : Promise.reject(new Error('not found')),
  );
});

describe('useNonMemberInvite — user groups', () => {
  it("offers a mentioned group's members who aren't in the channel", async () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    expect(result.current.channelIsPrivate).toBe(true);
    act(() => result.current.checkMentions('ping @[group-oncall|oncall]'));
    await waitFor(() =>
      expect(result.current.pendingGroupInvites).toEqual([{ groupId: 'group-oncall', handle: 'oncall', missingUserIds: ['out1', 'out2'] }]),
    );
  });

  it('recognises a typed @handle of a known group', async () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    act(() => result.current.checkMentions('ping @oncall please'));
    await waitFor(() => expect(result.current.pendingGroupInvites.map((g) => g.groupId)).toEqual(['group-oncall']));
  });

  it('counts a group named both by its pill and typed once', async () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    act(() => result.current.checkMentions('@[group-oncall|oncall] and again @oncall'));
    await waitFor(() => expect(result.current.pendingGroupInvites).toHaveLength(1));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('skips disabled, empty and unreadable groups', async () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    act(() => result.current.checkMentions('@[group-off|off] @[group-missing|gone] @[group-empty|empty]'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(result.current.pendingGroupInvites).toEqual([]);
  });

  it('a newer check or a dismissal wins over a group lookup still in flight', async () => {
    let release: (v: unknown) => void = () => {};
    mockApiFetch.mockImplementation(() => new Promise((r) => { release = r; }));
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    act(() => result.current.checkMentions('@[group-oncall|oncall]'));
    act(() => result.current.clearInvites());
    await act(async () => release(GROUPS['/api/v1/usergroups/group-oncall']));
    expect(result.current.pendingGroupInvites).toEqual([]);
  });

  it('clears group invites when the next message mentions no group', async () => {
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    act(() => result.current.checkMentions('@[group-oncall|oncall]'));
    await waitFor(() => expect(result.current.pendingGroupInvites).toHaveLength(1));
    act(() => result.current.checkMentions('no groups here'));
    expect(result.current.pendingGroupInvites).toEqual([]);
  });

  it('offers nothing in a conversation, or without the roster caches', async () => {
    const dm = renderHook(() => useNonMemberInvite(undefined, 'me'), { wrapper });
    act(() => dm.result.current.checkMentions('@[group-oncall|oncall]'));
    expect(dm.result.current.pendingGroupInvites).toEqual([]);
    expect(mockApiFetch).not.toHaveBeenCalled();

    qc.removeQueries({ queryKey: queryKeys.allUsers() });
    qc.removeQueries({ queryKey: queryKeys.userGroups(false) });
    const { result } = renderHook(() => useNonMemberInvite('ch-1', 'me'), { wrapper });
    act(() => result.current.checkMentions('@oncall and @[group-oncall|oncall]'));
    // The typed handle is unknown without the list; the token still counts,
    // and nobody reads as inactive.
    await waitFor(() => expect(result.current.pendingGroupInvites[0]?.missingUserIds).toEqual(['out1', 'out2', 'gone']));
  });

  it('treats a channel missing from the list as public', () => {
    mockUserChannels = [];
    const { result } = renderHook(() => useNonMemberInvite('ch-x', 'me'), { wrapper });
    expect(result.current.channelIsPrivate).toBe(false);
  });
});
