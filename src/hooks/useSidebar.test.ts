import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useCategories,
  useCreateCategory,
  useUpdateCategory,
  useReorderCategories,
  useDeleteCategory,
  useFavoriteChannel,
  useSetCategory,
  useFavoriteConversation,
  useSetConversationCategory,
  useReorderSidebar,
  markLocalSidebarReorder,
  shouldRefetchSidebarForRemoteUpdate,
  resetSidebarReorderSessionState,
} from './useSidebar';
import type { SidebarReorderUpdate } from '@/lib/sidebar-reorder';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { ApiError, apiFetch } from '@/lib/api';

function createWrapperWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
  return { wrapper, queryClient, invalidateSpy };
}

describe('useCategories', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches sidebar categories', async () => {
    const cats = [{ id: 'c-1', name: 'Work', position: 0 }];
    vi.mocked(apiFetch).mockResolvedValue(cats);

    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useCategories(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories');
    expect(result.current.data).toEqual(cats);
  });
});

describe('useCreateCategory', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('POSTs the new category and invalidates the categories query', async () => {
    const created = { id: 'c-2', name: 'Side projects', position: 1 };
    vi.mocked(apiFetch).mockResolvedValue(created);

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useCreateCategory(), { wrapper });
    result.current.mutate('Side projects');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'Side projects' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sidebarCategories'] });
  });
});

describe('useUpdateCategory', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('PATCHes the category and invalidates the categories query', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'c-1', name: 'Renamed', position: 2 });

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useUpdateCategory(), { wrapper });
    result.current.mutate({ id: 'c-1', name: 'Renamed', position: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/c-1', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed', position: 2 }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sidebarCategories'] });
  });

  it('optimistically updates the category cache before the PATCH resolves', async () => {
    let resolvePatch!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => {
      resolvePatch = resolve;
    }));

    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['sidebarCategories'], [
      { id: 'c-1', name: 'Engineering', position: 1000 },
      { id: 'c-2', name: 'Operations', position: 2000 },
    ]);
    const { result } = renderHook(() => useUpdateCategory(), { wrapper });

    result.current.mutate({ id: 'c-1', position: 3000 });

    await waitFor(() => {
      expect(queryClient.getQueryData(['sidebarCategories'])).toEqual([
        { id: 'c-1', name: 'Engineering', position: 3000 },
        { id: 'c-2', name: 'Operations', position: 2000 },
      ]);
    });

    resolvePatch({ id: 'c-1', name: 'Engineering', position: 3000 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

});

describe('useReorderCategories', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('reports the drop event, paints optimistically, and applies the server order as truth', async () => {
    // The server owns positions: ONE move request goes out, and its response
    // (the canonical order) replaces the optimistic preview.
    const serverOrder = [
      { id: 'c-2', name: 'Operations', position: 1024 },
      { id: 'c-1', name: 'Engineering', position: 2048 },
    ];
    vi.mocked(apiFetch).mockResolvedValue({ categories: serverOrder });

    const { wrapper, queryClient, invalidateSpy } = createWrapperWithClient();
    queryClient.setQueryData(['sidebarCategories'], [
      { id: 'c-1', name: 'Engineering', position: 1000 },
      { id: 'c-2', name: 'Operations', position: 2000 },
    ]);
    const { result } = renderHook(() => useReorderCategories(), { wrapper });

    result.current.mutate({
      categories: [
        { id: 'c-2', name: 'Operations', position: 2000 },
        { id: 'c-1', name: 'Engineering', position: 1000 },
      ],
      movedID: 'c-2',
      afterID: '',
    });

    // Synchronous — same snap-back guard as the channel/DM reorder: the new
    // category order is in the cache on the next line, not an awaited tick later.
    expect(queryClient.getQueryData(['sidebarCategories'])).toEqual([
      { id: 'c-2', name: 'Operations', position: 1000 },
      { id: 'c-1', name: 'Engineering', position: 2000 },
    ]);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // ONE event-shaped request; no client-computed positions on the wire.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/c-2/move', {
      method: 'PUT',
      body: JSON.stringify({ afterID: '' }),
    });
    // The server's canonical order replaced the optimistic preview.
    expect(queryClient.getQueryData(['sidebarCategories'])).toEqual(serverOrder);
    // Deliberately NO post-write invalidate: the eventually-consistent category
    // list read would race the write and could revert the committed order.
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['sidebarCategories'] });
  });

  it('rolls back and refetches the truth on a 409 layout conflict', async () => {
    const conflict = new ApiError(409, 'sidebar: layout changed since it was read', {
      error: { code: 'sidebar_conflict', message: 'sidebar: layout changed since it was read' },
    });
    vi.mocked(apiFetch).mockRejectedValueOnce(conflict).mockResolvedValue({ categories: [] });
    const { wrapper, queryClient } = createWrapperWithClient();
    const before = [
      { id: 'c-1', name: 'Engineering', position: 1000 },
      { id: 'c-2', name: 'Operations', position: 2000 },
    ];
    queryClient.setQueryData(['sidebarCategories'], before);
    const { result } = renderHook(() => useReorderCategories(), { wrapper });

    result.current.mutate({ categories: [before[1], before[0]], movedID: 'c-2', afterID: '' });
    await waitFor(() => expect(result.current.isError).toBe(true));
    // Rolled back to what the user had…
    expect(queryClient.getQueryData(['sidebarCategories'])).toEqual(before);
    // …and marked stale so the next render refetches the server's layout.
    expect(queryClient.getQueryState(['sidebarCategories'])?.isInvalidated).toBe(true);
  });
});

describe('useDeleteCategory', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('DELETEs the category and invalidates both sidebar and userChannels queries', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useDeleteCategory(), { wrapper });
    result.current.mutate('c-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sidebar/categories/c-1', { method: 'DELETE' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['sidebarCategories'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userChannels'] });
  });
});

describe('useFavoriteChannel', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('PUTs the favorite flag and invalidates userChannels', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useFavoriteChannel(), { wrapper });
    result.current.mutate({ channelID: 'ch-1', favorite: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/favorite', {
      method: 'PUT',
      body: JSON.stringify({ favorite: true }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userChannels'] });
  });

  it('optimistically updates the favorite flag before the PUT resolves', async () => {
    let resolvePut!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => {
      resolvePut = resolve;
    }));

    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userChannels'], [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1, favorite: false },
    ]);
    const { result } = renderHook(() => useFavoriteChannel(), { wrapper });

    result.current.mutate({ channelID: 'ch-1', favorite: true });

    await waitFor(() => {
      expect(queryClient.getQueryData(['userChannels'])).toEqual([
        { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1, favorite: true },
      ]);
    });

    resolvePut(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('handles optimistic favorite updates when the channel cache has not loaded yet', async () => {
    let resolvePut!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => {
      resolvePut = resolve;
    }));

    const { wrapper, queryClient } = createWrapperWithClient();
    const { result } = renderHook(() => useFavoriteChannel(), { wrapper });

    result.current.mutate({ channelID: 'ch-1', favorite: true });

    await waitFor(() => {
      expect(queryClient.getQueryData(['userChannels'])).toBeUndefined();
    });

    resolvePut(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('useSetCategory', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('PUTs the channel category and invalidates userChannels', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useSetCategory(), { wrapper });
    result.current.mutate({ channelID: 'ch-9', categoryID: 'c-3' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-9/category', {
      method: 'PUT',
      body: JSON.stringify({ categoryID: 'c-3' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userChannels'] });
  });

  it('supports clearing the category by passing an empty string', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useSetCategory(), { wrapper });
    result.current.mutate({ channelID: 'ch-9', categoryID: '' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-9/category', {
      method: 'PUT',
      body: JSON.stringify({ categoryID: '' }),
    });
  });

  it('PUTs an optional channel sidebar position with the category', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useSetCategory(), { wrapper });
    result.current.mutate(
      { channelID: 'ch-9', categoryID: 'c-3', sidebarPosition: 1500 },
      { onError: () => undefined },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-9/category', {
      method: 'PUT',
      body: JSON.stringify({ categoryID: 'c-3', sidebarPosition: 1500 }),
    });
  });

  it('optimistically updates the channel category and sidebar position before the PUT resolves', async () => {
    let resolvePut!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => {
      resolvePut = resolve;
    }));

    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userChannels'], [
      { channelID: 'ch-9', channelName: 'secret', channelType: 'private', role: 1, categoryID: 'old', sidebarPosition: 1000 },
    ]);
    const { result } = renderHook(() => useSetCategory(), { wrapper });

    result.current.mutate({ channelID: 'ch-9', categoryID: 'c-3', sidebarPosition: 1500 });

    await waitFor(() => {
      expect(queryClient.getQueryData(['userChannels'])).toEqual([
        { channelID: 'ch-9', channelName: 'secret', channelType: 'private', role: 1, categoryID: 'c-3', sidebarPosition: 1500 },
      ]);
    });

    resolvePut(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

});

describe('useFavoriteConversation', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('PUTs the favorite flag and invalidates userConversations', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useFavoriteConversation(), { wrapper });
    result.current.mutate({ conversationID: 'c-1', favorite: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/c-1/favorite', {
      method: 'PUT',
      body: JSON.stringify({ favorite: true }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userConversations'] });
  });

  it('optimistically updates a conversation favorite before the PUT resolves', async () => {
    let resolvePut!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => {
      resolvePut = resolve;
    }));

    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userConversations'], [
      { conversationID: 'conv-1', type: 'dm', displayName: 'Alice', favorite: false },
    ]);
    const { result } = renderHook(() => useFavoriteConversation(), { wrapper });

    result.current.mutate({ conversationID: 'conv-1', favorite: true });

    await waitFor(() => {
      expect(queryClient.getQueryData(['userConversations'])).toEqual([
        { conversationID: 'conv-1', type: 'dm', displayName: 'Alice', favorite: true },
      ]);
    });

    resolvePut(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

});

describe('useSetConversationCategory', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('PUTs the conversation category and invalidates userConversations', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper, invalidateSpy } = createWrapperWithClient();
    const { result } = renderHook(() => useSetConversationCategory(), { wrapper });
    result.current.mutate({ conversationID: 'c-9', categoryID: 'cat-eng' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/c-9/category', {
      method: 'PUT',
      body: JSON.stringify({ categoryID: 'cat-eng' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userConversations'] });
  });

  it('supports clearing the conversation category', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useSetConversationCategory(), { wrapper });
    result.current.mutate({ conversationID: 'c-9', categoryID: '' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/c-9/category', {
      method: 'PUT',
      body: JSON.stringify({ categoryID: '' }),
    });
  });

  it('PUTs an optional conversation sidebar position with the category', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useSetConversationCategory(), { wrapper });
    result.current.mutate({ conversationID: 'c-9', categoryID: 'cat-eng', sidebarPosition: 2500 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/c-9/category', {
      method: 'PUT',
      body: JSON.stringify({ categoryID: 'cat-eng', sidebarPosition: 2500 }),
    });
  });

  it('optimistically updates the conversation category and sidebar position before the PUT resolves', async () => {
    let resolvePut!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => {
      resolvePut = resolve;
    }));

    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userConversations'], [
      { conversationID: 'c-9', type: 'group', displayName: 'Team', categoryID: 'old', sidebarPosition: 1000 },
    ]);
    const { result } = renderHook(() => useSetConversationCategory(), { wrapper });

    result.current.mutate({ conversationID: 'c-9', categoryID: 'cat-eng', sidebarPosition: 2500 });

    await waitFor(() => {
      expect(queryClient.getQueryData(['userConversations'])).toEqual([
        { conversationID: 'c-9', type: 'group', displayName: 'Team', categoryID: 'cat-eng', sidebarPosition: 2500 },
      ]);
    });

    resolvePut(undefined);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('useReorderSidebar', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    resetSidebarReorderSessionState();
  });

  const updates: SidebarReorderUpdate[] = [
    { id: 'ch-1', kind: 'channel', categoryID: '', favorite: false, sidebarPosition: 1000 },
    { id: 'ch-2', kind: 'channel', categoryID: '', favorite: false, sidebarPosition: 2000 },
  ];

  const move = {
    itemType: 'channel' as const,
    itemID: 'ch-1',
    section: 'channels' as const,
    afterType: '' as const,
    afterID: '',
  };

  it('paints optimistically, sends ONE move event, and applies the server order as truth', async () => {
    // The server answers with what it actually wrote — here a different
    // position than the optimistic preview (it slotted into a gap).
    vi.mocked(apiFetch).mockResolvedValue({
      updates: [{ itemType: 'channel', itemID: 'ch-1', position: 512 }],
    });
    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userChannels'], [
      { channelID: 'ch-1', channelName: 'a', sidebarPosition: 5000 },
      { channelID: 'ch-2', channelName: 'b', sidebarPosition: 1000 },
    ]);
    const { result } = renderHook(() => useReorderSidebar(), { wrapper });

    result.current.mutate({ move, updates });

    // SYNCHRONOUS optimistic patch: onMutate applies it BEFORE it awaits the
    // query cancellation, so the cache already holds the new order on the very
    // next line — no awaited tick. This is the snap-back guard: if the patch is
    // moved back behind the await, the row commits at its OLD slot for one frame
    // on release (a visible flash back to the old position) and this fails.
    const rows = queryClient.getQueryData(['userChannels']) as Array<{ channelID: string; sidebarPosition: number }>;
    expect(rows.find((r) => r.channelID === 'ch-1')?.sidebarPosition).toBe(1000);
    expect(rows.find((r) => r.channelID === 'ch-2')?.sidebarPosition).toBe(2000);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // ONE event-shaped request — no client-computed positions on the wire.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sidebar/move', {
      method: 'PUT',
      body: JSON.stringify({
        itemType: 'channel',
        itemID: 'ch-1',
        section: 'channels',
        categoryID: '',
        afterType: '',
        afterID: '',
      }),
    });
    // The server's committed position replaced the optimistic one.
    const after = queryClient.getQueryData(['userChannels']) as Array<{ channelID: string; sidebarPosition: number }>;
    expect(after.find((r) => r.channelID === 'ch-1')?.sidebarPosition).toBe(512);
    // Untouched rows keep their optimistic state (the server didn't rewrite them).
    expect(after.find((r) => r.channelID === 'ch-2')?.sidebarPosition).toBe(2000);
  });

  it('arms the self-echo ignore window on mutate', () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useReorderSidebar(), { wrapper });
    expect(shouldRefetchSidebarForRemoteUpdate()).toBe(true);
    result.current.mutate({ move, updates });
    expect(shouldRefetchSidebarForRemoteUpdate()).toBe(false); // suppressed
    resetSidebarReorderSessionState();
  });

  it('applies server-confirmed favorite/category attributes on the moved row', async () => {
    // A move into Favorites: the server sets the flag itself and reports it
    // back — no separate favorite endpoint call.
    vi.mocked(apiFetch).mockResolvedValue({
      updates: [{ itemType: 'channel', itemID: 'ch-1', position: 1024, favorite: true, categoryID: 'work' }],
    });
    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'a' }]);
    const { result } = renderHook(() => useReorderSidebar(), { wrapper });
    const favUpdates: SidebarReorderUpdate[] = [
      { id: 'ch-1', kind: 'channel', categoryID: 'work', favorite: true, sidebarPosition: 1000 },
    ];
    result.current.mutate({
      move: { itemType: 'channel', itemID: 'ch-1', section: 'favorites', afterType: '', afterID: '' },
      updates: favUpdates,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Single move request; the server's response carried the attributes.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const row = (queryClient.getQueryData(['userChannels']) as Array<{ channelID: string; favorite?: boolean; categoryID?: string; sidebarPosition?: number }>)[0];
    expect(row).toMatchObject({ channelID: 'ch-1', favorite: true, categoryID: 'work', sidebarPosition: 1024 });
  });

  it('rolls the cache back to the pre-drop order when a write fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network'));
    const { wrapper, queryClient } = createWrapperWithClient();
    const original = [
      { channelID: 'ch-1', channelName: 'a', sidebarPosition: 5000 },
      { channelID: 'ch-2', channelName: 'b', sidebarPosition: 1000 },
    ];
    queryClient.setQueryData(['userChannels'], original);
    const { result } = renderHook(() => useReorderSidebar(), { wrapper });

    result.current.mutate({ move, updates });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const rows = queryClient.getQueryData(['userChannels']) as Array<{ channelID: string; sidebarPosition: number }>;
    expect(rows.find((r) => r.channelID === 'ch-1')?.sidebarPosition).toBe(5000);
    expect(rows.find((r) => r.channelID === 'ch-2')?.sidebarPosition).toBe(1000);
  });

  it('a 409 layout conflict rolls back AND marks both lists stale for a truth refetch', async () => {
    const conflict = new ApiError(409, 'sidebar: layout changed since it was read', {
      error: { code: 'sidebar_conflict', message: 'sidebar: layout changed since it was read' },
    });
    vi.mocked(apiFetch).mockRejectedValue(conflict);
    const { wrapper, queryClient } = createWrapperWithClient();
    queryClient.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'a', sidebarPosition: 5000 }]);
    queryClient.setQueryData(['userConversations'], [{ conversationID: 'cv-1', sidebarPosition: 1000 }]);
    const { result } = renderHook(() => useReorderSidebar(), { wrapper });

    result.current.mutate({ move, updates });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryState(['userChannels'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['userConversations'])?.isInvalidated).toBe(true);
  });

  it('markLocalSidebarReorder + reset toggle the window', () => {
    resetSidebarReorderSessionState();
    expect(shouldRefetchSidebarForRemoteUpdate()).toBe(true);
    markLocalSidebarReorder();
    expect(shouldRefetchSidebarForRemoteUpdate()).toBe(false);
    resetSidebarReorderSessionState();
    expect(shouldRefetchSidebarForRemoteUpdate()).toBe(true);
  });
});
