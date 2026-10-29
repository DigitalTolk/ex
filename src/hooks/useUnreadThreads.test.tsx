import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUnreadThreadIDs } from './useUnreadThreads';
import { markThreadSeen } from './useThreads';
import { UnreadProvider, useUnread } from '@/context/UnreadContext';
import { queryKeys } from '@/lib/query-keys';
import type { UserState } from '@/types';

function client() {
  const qc = new QueryClient();
  qc.setQueryData<Partial<UserState>>(queryKeys.userState(), { threadNotifications: ['t-1'] });
  return qc;
}

afterEach(() => localStorage.clear());

describe('useUnreadThreadIDs', () => {
  it('reads the unread threads from the loaded user state and follows its changes, without fetching', async () => {
    const qc = client();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUnreadThreadIDs(), { wrapper });
    expect([...result.current]).toEqual(['t-1']);
    act(() => {
      qc.setQueryData<Partial<UserState>>(queryKeys.userState(), { threadNotifications: ['t-1', 't-2'] });
    });
    await waitFor(() => expect([...result.current].sort()).toEqual(['t-1', 't-2']));
    expect(qc.getQueryCache().find({ queryKey: queryKeys.userState() })?.getObserversCount()).toBe(0);
  });

  // Seeing a thread takes it out at once: the app's own query client is the
  // one markThreadSeen updates.
  it('drops a thread the moment it is seen', async () => {
    const { queryClient } = await import('@/lib/query-client');
    queryClient.setQueryData<Partial<UserState>>(queryKeys.userState(), { threadNotifications: ['t-1', 't-2'] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUnreadThreadIDs(), { wrapper });
    act(() => markThreadSeen('t-1', '2026-10-07T11:00:00Z'));
    await waitFor(() => expect([...result.current]).toEqual(['t-2']));
    queryClient.removeQueries({ queryKey: queryKeys.userState() });
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
