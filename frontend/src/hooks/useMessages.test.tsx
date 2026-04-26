import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { useEditMessage, useDeleteMessage, useToggleReaction } from './useMessages';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useEditMessage', () => {
  it('PATCHes the channel-scoped URL when channelId is provided', async () => {
    mockApiFetch.mockResolvedValueOnce({ id: 'm1', body: 'edited' });
    const { result } = renderHook(() => useEditMessage(), { wrapper: makeWrapper() });

    result.current.mutate({ messageId: 'm1', body: 'edited', channelId: 'ch1' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/channels/ch1/messages/m1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ body: 'edited' }) }),
    );
  });

  it('PATCHes the conversation-scoped URL when conversationId is provided', async () => {
    mockApiFetch.mockResolvedValueOnce({ id: 'm1', body: 'edited' });
    const { result } = renderHook(() => useEditMessage(), { wrapper: makeWrapper() });

    result.current.mutate({ messageId: 'm1', body: 'edited', conversationId: 'conv1' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/conversations/conv1/messages/m1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('throws when neither channelId nor conversationId is provided', async () => {
    const { result } = renderHook(() => useEditMessage(), { wrapper: makeWrapper() });
    result.current.mutate({ messageId: 'm1', body: 'edited' });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useDeleteMessage', () => {
  it('DELETEs the channel-scoped URL', async () => {
    mockApiFetch.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteMessage(), { wrapper: makeWrapper() });

    result.current.mutate({ messageId: 'm9', channelId: 'ch9' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/channels/ch9/messages/m9',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('DELETEs the conversation-scoped URL', async () => {
    mockApiFetch.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteMessage(), { wrapper: makeWrapper() });

    result.current.mutate({ messageId: 'm9', conversationId: 'cv9' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/conversations/cv9/messages/m9',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

describe('useToggleReaction', () => {
  it('POSTs to channel reactions URL with emoji body', async () => {
    mockApiFetch.mockResolvedValueOnce({ id: 'm1', reactions: { '👍': ['u1'] } });
    const { result } = renderHook(() => useToggleReaction(), { wrapper: makeWrapper() });

    result.current.mutate({ messageId: 'm1', emoji: '👍', channelId: 'ch1' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/channels/ch1/messages/m1/reactions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ emoji: '👍' }) }),
    );
  });

  it('POSTs to conversation reactions URL', async () => {
    mockApiFetch.mockResolvedValueOnce({ id: 'm1', reactions: { '🎉': ['u1'] } });
    const { result } = renderHook(() => useToggleReaction(), { wrapper: makeWrapper() });

    result.current.mutate({ messageId: 'm1', emoji: '🎉', conversationId: 'cv1' });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/conversations/cv1/messages/m1/reactions',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
