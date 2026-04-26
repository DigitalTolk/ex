import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useCategories,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useFavoriteChannel,
  useSetCategory,
  useFavoriteConversation,
  useSetConversationCategory,
} from './useSidebar';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

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
});
