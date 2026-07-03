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
import { resetDraftSessionState, shouldRefetchDraftsForRemoteUpdate } from './useDrafts';
import { resetUserStateSessionState, shouldRefetchUserStateForRemoteUpdate } from './useUserState';

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
    const calls = vi.mocked(apiFetch).mock.calls as Array<[string, { method?: string; body?: string }?]>;
    const call = calls.find((c) => c[0] === '/api/v1/channels/ch-1/messages');
    expect(call?.[1]?.method).toBe('POST');
    const sent = JSON.parse(String(call?.[1]?.body));
    expect(sent).toMatchObject({ body: 'hello', parentMessageID: '', attachmentIDs: [] });
    // The send carries clientTs so the server folds the draft-clear into it.
    expect(sent.clientTs).toBeGreaterThan(0);
  });

  it('posting a thread reply optimistically appends to the open thread without any /threads refetch', async () => {
    // The sender's reply must show immediately rather than waiting for the
    // WS round-trip (the user-reported "visible delay" posting in threads).
    // We append the returned reply straight into the thread cache. The /threads
    // list is patched live by the participant-scoped `thread.updated` event
    // (the sender is a participant), so we no longer fire an eventually-
    // consistent ListUserThreads refetch here that could race that patch — nor
    // do we invalidate the thread query itself (a refetch could briefly drop
    // the just-added reply).
    const reply = { id: 'r-1', parentID: 'ch-1', parentMessageID: 'root', authorID: 'u-1', body: 'r', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(reply);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = { id: 'root', parentID: 'ch-1', authorID: 'u-2', body: 'root', createdAt: '' };
    queryClient.setQueryData(['thread', 'channels/ch-1', 'root'], [root]);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    result.current.mutate({ body: 'r', attachmentIDs: [], parentMessageID: 'root' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Reply is visible in the thread immediately.
    expect(queryClient.getQueryData(['thread', 'channels/ch-1', 'root'])).toEqual([root, reply]);
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(keys).not.toContainEqual(['userThreads']);
    expect(keys).not.toContainEqual(['thread', 'channels/ch-1', 'root']);
  });

  it('does not duplicate a thread reply already present in the cache (echo dedup)', async () => {
    const reply = { id: 'r-1', parentID: 'ch-1', parentMessageID: 'root', authorID: 'u-1', body: 'r', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(reply);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Reply id already in the thread (e.g. WS echo landed first).
    queryClient.setQueryData(['thread', 'channels/ch-1', 'root'], [reply]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    result.current.mutate({ body: 'r', attachmentIDs: [], parentMessageID: 'root' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(['thread', 'channels/ch-1', 'root'])).toEqual([reply]);
  });

  it('skips the optimistic thread append when the thread is not open (no cache to patch)', async () => {
    const reply = { id: 'r-1', parentID: 'ch-1', parentMessageID: 'root', authorID: 'u-1', body: 'r', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(reply);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    result.current.mutate({ body: 'r', attachmentIDs: [], parentMessageID: 'root' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // No thread cache existed → nothing created (avoids a partial one-item list).
    expect(queryClient.getQueryData(['thread', 'channels/ch-1', 'root'])).toBeUndefined();
  });

  it('first reply to a thread MISSING from the cached /threads list refetches it (thread.updated may never fire)', async () => {
    // The live `thread.updated` patch is gated on the server's reply-metadata
    // bump succeeding. A sender whose reply just created their participation
    // cannot depend on it: with a cached list lacking this thread's row, the
    // send must invalidate userThreads so the row appears regardless.
    const reply = { id: 'r-1', parentID: 'ch-1', parentMessageID: 'root', authorID: 'u-1', body: 'r', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(reply);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userThreads'], [{ threadRootID: 'other-thread' }]);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    result.current.mutate({ body: 'r', attachmentIDs: [], parentMessageID: 'root' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(keys).toContainEqual(['userThreads']);
  });

  it('a reply to a thread ALREADY in the cached /threads list does not refetch (the event patch owns it)', async () => {
    const reply = { id: 'r-1', parentID: 'ch-1', parentMessageID: 'root', authorID: 'u-1', body: 'r', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(reply);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['userThreads'], [{ threadRootID: 'root' }]);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    result.current.mutate({ body: 'r', attachmentIDs: [], parentMessageID: 'root' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(keys).not.toContainEqual(['userThreads']);
  });

  it('non-thread send does NOT invalidate userThreads (avoids needless /threads refetches)', async () => {
    const msg = { id: 'msg-x', parentID: 'ch-1', authorID: 'u-1', body: 'hi', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(msg);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    result.current.mutate({ body: 'hi', attachmentIDs: [] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(keys).not.toContainEqual(['userThreads']);
  });

  it('arms the drafts-echo ignore window at MUTATE time, before the POST resolves', async () => {
    // The server folds the draft-clear into message creation and publishes
    // draft.updated while the POST is still in flight. Arming the window in
    // the views' onSuccess was too late — the echo raced it and every send
    // triggered a full /drafts refetch.
    resetDraftSessionState();
    expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
    const msg = { id: 'msg-w', parentID: 'ch-1', authorID: 'u-1', body: 'hi', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(msg);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    try {
      result.current.mutate({ body: 'hi', attachmentIDs: [] });
      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(false);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    } finally {
      resetDraftSessionState();
    }
  });
});

describe('useSendMessage user-state echo window', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('a THREAD reply arms the user-state echo window (the backend marks the author seen); a top-level send does not', async () => {
    resetUserStateSessionState();
    const reply = { id: 'r-1', parentID: 'ch-1', parentMessageID: 'root', authorID: 'u-1', body: 'r', createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(reply);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSendChannelMessage('ch-1'), { wrapper });
    try {
      expect(shouldRefetchUserStateForRemoteUpdate()).toBe(true);
      result.current.mutate({ body: 'top level', attachmentIDs: [] });
      expect(shouldRefetchUserStateForRemoteUpdate()).toBe(true); // no author-seen echo for top-level
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      result.current.mutate({ body: 'r', attachmentIDs: [], parentMessageID: 'root' });
      expect(shouldRefetchUserStateForRemoteUpdate()).toBe(false); // armed before the POST resolves
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    } finally {
      resetUserStateSessionState();
      resetDraftSessionState();
    }
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
    const calls = vi.mocked(apiFetch).mock.calls as Array<[string, { method?: string; body?: string }?]>;
    const call = calls.find((c) => c[0] === '/api/v1/conversations/conv-1/messages');
    expect(call?.[1]?.method).toBe('POST');
    const sent = JSON.parse(String(call?.[1]?.body));
    expect(sent).toMatchObject({ body: 'hi there', parentMessageID: '', attachmentIDs: [] });
    expect(sent.clientTs).toBeGreaterThan(0);
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
