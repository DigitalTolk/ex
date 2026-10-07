import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMarkUnread } from './useMarkUnread';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { queryKeys } from '@/lib/query-keys';
import { endReadSession, getUnreadAnchor, isReadHeld, threadReadKey } from '@/lib/read-position';
import { getSeenMap, resetSeenCache } from '@/hooks/useThreads';
import type { UserChannel, UserConversation, UserState } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
    { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
  ]);
  qc.setQueryData<UserConversation[]>(queryKeys.userConversations(), [
    { conversationID: 'dm-1', type: 'dm', displayName: 'Me' } as UserConversation,
  ]);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useMarkUnread(), { wrapper });
  return { qc, result };
}

afterEach(() => {
  for (const key of ['ch-1', 'dm-1', threadReadKey('root-1')]) endReadSession(key);
  vi.mocked(apiFetch).mockReset();
});

describe('useMarkUnread', () => {
  it('a channel message: PUTs, holds the chat unread, moves the line, sets the count', async () => {
    const { qc, result } = setup();
    vi.mocked(apiFetch).mockResolvedValueOnce({ parentID: 'ch-1', parentType: 'channel', messageID: 'm-2', unreadCount: 3 });
    await act(() => result.current.mutateAsync({ parentID: 'ch-1', parentType: 'channel', messageID: 'm-2' }));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/messages/m-2/unread', { method: 'PUT' });
    expect(isReadHeld('ch-1')).toBe(true);
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'message', messageID: 'm-2' });
    expect(qc.getQueryData<UserChannel[]>(queryKeys.userChannels())![0]).toMatchObject({ unread: true, unreadCount: 3 });
  });

  it('a self-DM message rewinds the conversation the same way', async () => {
    const { qc, result } = setup();
    vi.mocked(apiFetch).mockResolvedValueOnce({ parentID: 'dm-1', parentType: 'conversation', messageID: 'm-1', unreadCount: 2 });
    await act(() => result.current.mutateAsync({ parentID: 'dm-1', parentType: 'conversation', messageID: 'm-1' }));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/dm-1/messages/m-1/unread', { method: 'PUT' });
    expect(isReadHeld('dm-1')).toBe(true);
    expect(qc.getQueryData<UserConversation[]>(queryKeys.userConversations())![0]).toMatchObject({ unread: true, unreadCount: 2 });
  });

  it('a thread reply rewinds the thread: local + cached seen time, the mark, the flag', async () => {
    localStorage.clear();
    resetSeenCache();
    const { qc, result } = setup();
    qc.setQueryData<UserState>(queryKeys.userState(), {
      threadNotifications: [],
      threadSeen: { 'root-1': '2026-10-07T10:00:00Z' },
      hiddenConversations: [],
      hiddenSkills: [],
    });
    const seenAt = '2026-10-07T09:00:00.999Z';
    vi.mocked(apiFetch).mockResolvedValue({ parentID: 'ch-1', parentType: 'channel', messageID: 'r-1', unreadCount: 0, threadRootID: 'root-1', seenAt });
    await act(() => result.current.mutateAsync({ parentID: 'ch-1', parentType: 'channel', messageID: 'r-1' }));
    expect(isReadHeld(threadReadKey('root-1'))).toBe(true);
    expect(isReadHeld('ch-1')).toBe(false);
    expect(getUnreadAnchor(threadReadKey('root-1'))).toEqual({ kind: 'message', messageID: 'r-1' });
    expect(getSeenMap()['root-1']).toBe(seenAt);
    const state = qc.getQueryData<UserState>(queryKeys.userState())!;
    expect(state.threadSeen['root-1']).toBe(seenAt);
    expect(state.threadMarkedUnread?.['root-1']).toBeTruthy();
    expect(state.threadNotifications).toEqual(['root-1']);

    // Marking again keeps the flag list free of duplicates; no cached state is fine too.
    await act(() => result.current.mutateAsync({ parentID: 'ch-1', parentType: 'channel', messageID: 'r-1' }));
    expect(qc.getQueryData<UserState>(queryKeys.userState())!.threadNotifications).toEqual(['root-1']);
    qc.removeQueries({ queryKey: queryKeys.userState() });
    await act(() => result.current.mutateAsync({ parentID: 'ch-1', parentType: 'channel', messageID: 'r-1' }));
    expect(qc.getQueryData(queryKeys.userState())).toBeUndefined();
  });

  it('says so when it fails', async () => {
    const { result } = setup();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('nope'));
    act(() => result.current.mutate({ parentID: 'ch-1', parentType: 'channel', messageID: 'm-1' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't mark the message unread — please try again."));
    expect(isReadHeld('ch-1')).toBe(false);
  });
});
