import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useConversationMessages,
  useSendChannelMessage,
  useSendConversationMessage,
  useEditMessage,
  useDeleteMessage,
} from './useMessages';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useConversationMessages', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches messages for a conversation', async () => {
    const page = { items: [{ id: 'msg-1', parentID: 'conv-1', authorID: 'u-1', body: 'hi', createdAt: '' }], hasMore: false };
    vi.mocked(apiFetch).mockResolvedValue(page);

    const { result } = renderHook(() => useConversationMessages('conv-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/v1/conversations/conv-1/messages'));
  });

  it('is disabled when conversationId is undefined', () => {
    const { result } = renderHook(() => useConversationMessages(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useSendChannelMessage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('posts message to channel endpoint', async () => {
    const msg = { id: 'msg-new', parentID: 'ch-1', authorID: 'u-1', body: 'hello', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(msg);

    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper: createWrapper() });
    result.current.mutate({ body: 'hello', attachmentIDs: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'hello', parentMessageID: '', attachmentIDs: [] }),
    });
  });
});

describe('useSendConversationMessage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('posts message to conversation endpoint', async () => {
    const msg = { id: 'msg-new', parentID: 'conv-1', authorID: 'u-1', body: 'hi there', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(msg);

    const { result } = renderHook(() => useSendConversationMessage('conv-1'), { wrapper: createWrapper() });
    result.current.mutate({ body: 'hi there', attachmentIDs: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv-1/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'hi there', parentMessageID: '', attachmentIDs: [] }),
    });
  });
});

describe('useEditMessage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('patches message at correct endpoint', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'msg-1', body: 'edited', parentID: 'ch-1', authorID: 'u-1', createdAt: '' });

    const { result } = renderHook(() => useEditMessage(), { wrapper: createWrapper() });
    result.current.mutate({ messageId: 'msg-1', body: 'edited', channelId: 'ch-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/messages/msg-1', {
      method: 'PATCH',
      body: JSON.stringify({ body: 'edited' }),
    });
  });
});

describe('useDeleteMessage', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('deletes message at correct endpoint', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteMessage(), { wrapper: createWrapper() });
    result.current.mutate({ messageId: 'msg-1', channelId: 'ch-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/messages/msg-1', { method: 'DELETE' });
  });

  it('deletes message with conversationId', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteMessage(), { wrapper: createWrapper() });
    result.current.mutate({ messageId: 'msg-2', conversationId: 'conv-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv-1/messages/msg-2', { method: 'DELETE' });
  });
});
