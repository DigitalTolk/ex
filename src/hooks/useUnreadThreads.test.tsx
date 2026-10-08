import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUnreadThreadIDs } from './useUnreadThreads';
import { markThreadSeen, type ThreadSummary } from './useThreads';
import { UnreadProvider, useUnread } from '@/context/UnreadContext';
import { queryKeys } from '@/lib/query-keys';
import type { UserState } from '@/types';

const thread = (id: string, at = '2026-10-07T10:00:00Z'): ThreadSummary => ({
  parentID: 'ch-1',
  parentType: 'channel',
  threadRootID: id,
  rootAuthorID: 'u-1',
  rootBody: 'hi',
  rootCreatedAt: '2026-10-07T09:00:00Z',
  replyCount: 2,
  latestActivityAt: at,
});

function client() {
  const qc = new QueryClient();
  qc.setQueryData<ThreadSummary[]>(queryKeys.userThreads(), [thread('t-1'), thread('t-2'), thread('t-3')]);
  qc.setQueryData<Partial<UserState>>(queryKeys.userState(), { threadNotifications: ['t-1'] });
  return qc;
}

afterEach(() => localStorage.clear());

describe('useUnreadThreadIDs', () => {
  it('reads the unread threads from the loaded caches and follows their changes, without fetching', async () => {
    const qc = client();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUnreadThreadIDs(), { wrapper });
    expect([...result.current]).toEqual(['t-1']);
    act(() => {
      qc.setQueryData<Partial<UserState>>(queryKeys.userState(), { threadNotifications: ['t-1', 't-2'] });
    });
    await waitFor(() => expect([...result.current].sort()).toEqual(['t-1', 't-2']));
    // Reading a thread here (the seen map) takes it out at once.
    act(() => markThreadSeen('t-1', '2026-10-07T11:00:00Z'));
    expect([...result.current]).toEqual(['t-2']);
    expect(qc.getQueryCache().find({ queryKey: queryKeys.userThreads() })?.getObserversCount()).toBe(0);
  });

  it('works before anything is loaded', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUnreadThreadIDs(), { wrapper });
    expect(result.current.size).toBe(0);
  });

  it('includes a reply that just arrived live', () => {
    const qc = new QueryClient();
    qc.setQueryData<ThreadSummary[]>(queryKeys.userThreads(), [thread('t-4'), thread('t-5')]);
    qc.setQueryData<Partial<UserState>>(queryKeys.userState(), { threadNotifications: ['t-4'] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>
        <UnreadProvider>{children}</UnreadProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => ({ ids: useUnreadThreadIDs(), unread: useUnread() }), { wrapper });
    act(() => result.current.unread.markThreadNotificationUnread('t-5'));
    expect([...result.current.ids].sort()).toEqual(['t-4', 't-5']);
  });
});
