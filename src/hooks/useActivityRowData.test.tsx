import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useActivityRowData } from './useActivityRowData';
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';
import { copyToClipboard } from '@/lib/clipboard';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/hooks/useEmoji', () => ({ useEmojiMap: () => ({ data: {} }) }));

const items = [
  { id: 'new', type: 'thread_reply', read: false, actorID: 'u-bob', parentID: 'ch-1', parentType: 'channel', messageID: 'm-3', parentMessageID: 'root-1', createdAt: '2026-10-14T10:00:00Z' },
  { id: 'mid', type: 'mention', read: false, actorID: 'u-bob', parentID: 'ch-1', parentType: 'channel', messageID: 'm-2', createdAt: '2026-10-14T09:00:00Z' },
  { id: 'old', type: 'dm', read: true, actorID: 'u-bob', parentID: 'cv-1', parentType: 'conversation', messageID: 'm-1', createdAt: '2026-10-14T08:00:00Z' },
];

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe('useActivityRowData actions', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(showToast).mockReset();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.startsWith('/api/v1/activity')) return { items, unread: 2, unreadByType: {} } as never;
      if (url === '/api/v1/channels') return [{ channelID: 'ch-1', channelName: 'General Chat', channelType: 'public' }] as never;
      if (url === '/api/v1/conversations') return [] as never;
      if (url === '/api/v1/users/batch') return [] as never;
      return undefined as never;
    });
  });

  async function ready() {
    const hook = renderHook(() => useActivityRowData(), { wrapper });
    await waitFor(() => expect(hook.result.current.allRows).toHaveLength(3));
    await waitFor(() => expect(hook.result.current.slugFor(hook.result.current.allRows[0])).toBe('general-chat'));
    return hook;
  }

  it('clears everything older than the row, and nothing when the row is the oldest', async () => {
    const { result } = await ready();
    act(() => result.current.onClearBefore(result.current.allRows[1]));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/activity/items/remove', expect.objectContaining({ body: JSON.stringify({ ids: ['old'] }) })),
    );
    // The optimistic patch dropped the old row; the oldest left has nothing before it.
    await waitFor(() => expect(result.current.allRows).toHaveLength(2));
    vi.mocked(apiFetch).mockClear();
    act(() => result.current.onClearBefore(result.current.allRows[1]));
    expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/activity/items/remove', expect.anything());
  });

  it('copies an absolute link to the row and says so', async () => {
    const { result } = await ready();
    await act(async () => {
      result.current.onCopyLink(result.current.allRows[1]);
    });
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/localhost[^ ]*\/channel\/general-chat/));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Link copied', 'success'));
  });

  it('turns off reply notifications by unfollowing the thread, and reports failure', async () => {
    const { result } = await ready();
    act(() => result.current.onMuteThread(result.current.allRows[0]));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/v1/threads/channels/ch-1/root-1/follow', expect.objectContaining({ method: 'DELETE' })),
    );
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('no longer be notified'), 'success'));

    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.includes('/follow')) throw new Error('nope');
      return [] as never;
    });
    act(() => result.current.onMuteThread(result.current.allRows[0]));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't turn off")));
  });

  it('names the slug for a channel row and nothing for a DM', async () => {
    const { result } = await ready();
    expect(result.current.slugFor(result.current.allRows[0])).toBe('general-chat');
    expect(result.current.slugFor(result.current.allRows[2])).toBeUndefined();
  });
});
