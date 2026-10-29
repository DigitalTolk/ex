import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { useChannelMembers, useUserChannels } from './useChannels';
import { useUserConversations } from './useConversations';
import { useCategories } from './useSidebar';
import { useDrafts } from './useDrafts';
import { useUserState } from './useUserState';
import { useThreadFollowing, useThreadMessages, useThreadPages } from './useThreads';
import { useActivity, useReminders } from './useActivity';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

// These lists are kept current by WebSocket events — patched in place or
// invalidated by ChatPage's handlers, and refetched after a socket gap
// (refreshAfterGap). Refetching them on every window focus (and on every new
// observer past a short stale time) bought nothing but requests.
const liveQueries: Array<[name: string, key: readonly unknown[], hook: () => unknown]> = [
  ['userChannels', queryKeys.userChannels(), () => useUserChannels()],
  ['userConversations', queryKeys.userConversations(), () => useUserConversations()],
  ['channelMembers', queryKeys.channelMembers('ch-1'), () => useChannelMembers('ch-1')],
  ['sidebarCategories', queryKeys.sidebarCategories(), () => useCategories()],
  ['drafts', queryKeys.drafts(), () => useDrafts()],
  ['userState', queryKeys.userState(), () => useUserState()],
  ['threadPages', queryKeys.threadPages('visit-1'), () => useThreadPages('visit-1')],
  ['threadFollow', queryKeys.threadFollow('ch-1', 'root-1'), () => useThreadFollowing({ parentID: 'ch-1', parentType: 'channel', threadRootID: 'root-1' })],
  ['thread', queryKeys.thread('channels/ch-1', 'root-1'), () => useThreadMessages({ channelId: 'ch-1', threadRootID: 'root-1' })],
  ['activity', queryKeys.activity(), () => useActivity()],
  ['reminders', queryKeys.reminders(), () => useReminders()],
];

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

describe('WebSocket-kept queries', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue([]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
    client.clear();
  });

  it.each(liveQueries)('%s is not refetched on window focus or by a new observer', async (_name, key, hook) => {
    const first = renderHook(hook, { wrapper });
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('success'));
    const calls = vi.mocked(apiFetch).mock.calls.length;
    expect(calls).toBe(1);
    // Fetched a while ago: past any finite stale time.
    act(() => {
      client.setQueryData(key, client.getQueryData(key), { updatedAt: Date.now() - 60 * 60_000 });
    });

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    renderHook(hook, { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.isFetching({ queryKey: key })).toBe(0);
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls);

    // An invalidation — the WS handlers' fallback and the gap refresh —
    // still refetches.
    await act(async () => {
      await client.invalidateQueries({ queryKey: key });
    });
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(calls + 1);
    first.unmount();
  });
});
