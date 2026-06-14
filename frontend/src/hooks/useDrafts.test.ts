import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  restoreDraftScope,
  restoreDraftScopeForContent,
  shouldRefetchDraftsForRemoteUpdate,
  suppressSentDraft,
  useDeleteDraft,
  useDraftAttachmentChips,
  useDraftForScope,
  useDrafts,
  useSaveDraft,
} from './useDrafts';
import type { MessageDraft } from '@/types';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useDrafts', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    restoreDraftScope({ parentID: 'dm-1', parentType: 'conversation' });
  });

  it('loads drafts and normalizes invalid responses to an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ nope: true });

    const { result } = renderHook(() => useDrafts(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts');
    expect(result.current.data).toEqual([]);
  });

  it('returns the draft matching the exact composer scope', async () => {
    const drafts: MessageDraft[] = [
      {
        id: 'draft-1',
        userID: 'u-1',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: '',
        body: 'main draft',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      },
      {
        id: 'draft-2',
        userID: 'u-1',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'root-1',
        body: 'thread draft',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:01:00Z',
        createdAt: '2026-05-03T10:01:00Z',
      },
    ];
    vi.mocked(apiFetch).mockResolvedValue(drafts);

    const { result } = renderHook(
      () => useDraftForScope({ parentID: 'ch-1', parentType: 'channel' }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('draft-1');
  });

  it('hides sent draft scopes so a late save cannot rehydrate the composer', async () => {
    const suppressed: MessageDraft = {
      id: 'draft-stale',
      userID: 'u-1',
      parentID: 'dm-1',
      parentType: 'conversation',
      parentMessageID: '',
      body: 'already sent',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:00:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    };
    const visible: MessageDraft = {
      id: 'draft-visible',
      userID: 'u-1',
      parentID: 'dm-2',
      parentType: 'conversation',
      parentMessageID: '',
      body: 'keep me',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:01:00Z',
      createdAt: '2026-05-03T10:01:00Z',
    };
    vi.mocked(apiFetch).mockResolvedValue([suppressed, visible]);

    suppressSentDraft({ parentID: 'dm-1', parentType: 'conversation' });
    const { result } = renderHook(() => useDrafts(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([visible]);
  });

  it('matches a thread-scoped draft and tolerates drafts missing parentMessageID', async () => {
    const drafts: MessageDraft[] = [
      {
        id: 'd-undef',
        userID: 'u-1',
        parentID: 'ch-1',
        parentType: 'channel',
        // parentMessageID intentionally undefined → exercises the `?? ''` fallback.
        body: 'no thread field',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      } as MessageDraft,
      {
        id: 'd-thread',
        userID: 'u-1',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'root-9',
        body: 'thread draft',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:01:00Z',
        createdAt: '2026-05-03T10:01:00Z',
      },
    ];
    vi.mocked(apiFetch).mockResolvedValue(drafts);

    const { result } = renderHook(
      () => useDraftForScope({ parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root-9' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('d-thread');
  });

  it('restores a suppressed scope when only attachments are present', async () => {
    const stale: MessageDraft = {
      id: 'draft-att',
      userID: 'u-1',
      parentID: 'dm-2',
      parentType: 'conversation',
      parentMessageID: '',
      body: '',
      attachmentIDs: ['a-1'],
      updatedAt: '2026-05-03T10:00:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    };
    const scope = { parentID: 'dm-2', parentType: 'conversation' as const };
    vi.mocked(apiFetch).mockResolvedValue([stale]);

    suppressSentDraft(scope);
    // Empty body but a pending attachment → the content-aware restore fires.
    restoreDraftScopeForContent(scope, { body: '', attachmentIDs: ['a-1'] });
    const restored = renderHook(() => useDrafts(), { wrapper: createWrapper() });
    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(restored.result.current.data).toEqual([stale]);
  });

  it('keeps a sent scope suppressed when an empty clear omits the attachmentIDs field', async () => {
    const stale: MessageDraft = {
      id: 'draft-noatt',
      userID: 'u-1',
      parentID: 'dm-3',
      parentType: 'conversation',
      parentMessageID: '',
      body: 'already sent',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:00:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    };
    const scope = { parentID: 'dm-3', parentType: 'conversation' as const };
    vi.mocked(apiFetch).mockResolvedValue([stale]);

    suppressSentDraft(scope);
    // No attachmentIDs key → `attachmentIDs?.length ?? 0` exercises the nullish
    // fallback; empty body means the scope stays suppressed.
    restoreDraftScopeForContent(scope, { body: '' });
    const hidden = renderHook(() => useDrafts(), { wrapper: createWrapper() });

    await waitFor(() => expect(hidden.result.current.isSuccess).toBe(true));
    expect(hidden.result.current.data).toEqual([]);
    restoreDraftScope(scope);
  });

  it('keeps sent draft scopes suppressed for empty clears and restores them when the user edits again', async () => {
    const stale: MessageDraft = {
      id: 'draft-stale',
      userID: 'u-1',
      parentID: 'dm-1',
      parentType: 'conversation',
      parentMessageID: '',
      body: 'already sent',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:00:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    };
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    vi.mocked(apiFetch).mockResolvedValue([stale]);

    suppressSentDraft(scope);
    restoreDraftScopeForContent(scope, { body: '', attachmentIDs: [] });
    const hidden = renderHook(() => useDrafts(), { wrapper: createWrapper() });

    await waitFor(() => expect(hidden.result.current.isSuccess).toBe(true));
    expect(hidden.result.current.data).toEqual([]);

    restoreDraftScopeForContent(scope, { body: 'new edit', attachmentIDs: [] });
    const restored = renderHook(() => useDrafts(), { wrapper: createWrapper() });

    await waitFor(() => expect(restored.result.current.isSuccess).toBe(true));
    expect(restored.result.current.data).toEqual([stale]);
  });

  it('saves and deletes drafts without trimming request bodies', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const wrapper = createWrapper();
    const save = renderHook(() => useSaveDraft(), { wrapper });
    const del = renderHook(() => useDeleteDraft(), { wrapper });

    save.result.current.mutate({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: '  hello\n\n',
    });
    await waitFor(() => expect(save.result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts', {
      method: 'PUT',
      body: JSON.stringify({
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: '  hello\n\n',
        attachmentIDs: [],
      }),
    });

    del.result.current.mutate('draft-1');
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts/draft-1', {
      method: 'DELETE',
    });
  });

  it('patches the drafts cache by scope after saves and empty clears', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      {
        id: 'draft-old',
        userID: 'u-1',
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'old',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      },
      {
        id: 'draft-other',
        userID: 'u-1',
        parentID: 'dm-2',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'other',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      },
    ]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const saved: MessageDraft = {
      id: 'draft-new',
      userID: 'u-1',
      parentID: 'dm-1',
      parentType: 'conversation',
      parentMessageID: '',
      body: 'new',
      attachmentIDs: [],
      updatedAt: '2026-05-03T10:01:00Z',
      createdAt: '2026-05-03T10:00:00Z',
    };
    vi.mocked(apiFetch).mockResolvedValueOnce(saved).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useSaveDraft(), { wrapper });
    result.current.mutate({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: 'new',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((draft) => draft.id)).toEqual([
      'draft-new',
      'draft-other',
    ]);

    result.current.mutate({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: '',
      attachmentIDs: [],
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((draft) => draft.id)).toEqual([
        'draft-other',
      ]);
    });
  });

  it('does not PUT duplicate draft saves or empty clears without a cached draft', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      {
        id: 'draft-1',
        userID: 'u-1',
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'same',
        attachmentIDs: ['a-2', 'a-1'],
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      },
    ]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSaveDraft(), { wrapper });

    await result.current.mutateAsync({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: 'same',
      attachmentIDs: ['a-1', 'a-2'],
    });
    await result.current.mutateAsync({
      parentID: 'dm-2',
      parentType: 'conversation',
      body: '',
      attachmentIDs: [],
    });

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('ignores stale draft save responses for the same scope', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    let resolveFirst!: (draft: MessageDraft) => void;
    vi.mocked(apiFetch)
      .mockReturnValueOnce(new Promise<MessageDraft>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({
        id: 'draft-new',
        userID: 'u-1',
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'new',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:01:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      });

    const { result } = renderHook(() => useSaveDraft(), { wrapper });
    const first = result.current.mutateAsync({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: 'old',
    });
    const second = result.current.mutateAsync({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: 'new',
    });
    await second;
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.[0]?.body).toBe('new');

    await act(async () => {
      resolveFirst({
        id: 'draft-old',
        userID: 'u-1',
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'old',
        attachmentIDs: [],
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      });
      await first;
    });
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.[0]?.body).toBe('new');
  });

  it('temporarily suppresses self-generated draft.updated refetches', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(9_999_999_999_999);
      vi.mocked(apiFetch).mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useSaveDraft(), { wrapper: createWrapper() });

      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
      act(() => {
        result.current.mutate({
          parentID: 'dm-1',
          parentType: 'conversation',
          body: 'draft',
        });
      });
      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(false);

      vi.setSystemTime(10_000_000_001_500);
      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dedups against a cached draft that omits parentMessageID and attachmentIDs', async () => {
    // The cached draft has both parentMessageID and attachmentIDs undefined,
    // exercising the `?? ''` scope fallback (sameDraftScope) and the `?? []`
    // fallback (sortedAttachmentIDs) when comparing the incoming save.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      {
        id: 'draft-bare',
        userID: 'u-1',
        parentID: 'dm-9',
        parentType: 'conversation',
        // parentMessageID + attachmentIDs intentionally omitted.
        body: 'same',
        updatedAt: '2026-05-03T10:00:00Z',
        createdAt: '2026-05-03T10:00:00Z',
      } as MessageDraft,
    ]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => useSaveDraft(), { wrapper });

    // Identical body + no attachments → matches the cached draft, so no PUT fires.
    await result.current.mutateAsync({
      parentID: 'dm-9',
      parentType: 'conversation',
      body: 'same',
    });

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('hydrates persisted draft attachment IDs into composer attachment chips', async () => {
    vi.mocked(apiFetch).mockResolvedValue([
      {
        id: 'att-2',
        filename: 'second.txt',
        contentType: 'text/plain',
        size: 20,
        createdBy: 'u-1',
        createdAt: '2026-05-03T10:00:00Z',
      },
      {
        id: 'att-1',
        filename: 'first.png',
        contentType: 'image/png',
        size: 10,
        url: 'https://cdn.example.test/first.png',
        createdBy: 'u-1',
        createdAt: '2026-05-03T10:00:00Z',
      },
    ]);

    const { result } = renderHook(() => useDraftAttachmentChips(['att-1', 'att-2']), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/attachments?ids=att-1%2Catt-2');
    expect(result.current).toEqual([
      {
        id: 'att-1',
        filename: 'first.png',
        contentType: 'image/png',
        size: 10,
        url: 'https://cdn.example.test/first.png',
        progress: 1,
      },
      {
        id: 'att-2',
        filename: 'second.txt',
        contentType: 'text/plain',
        size: 20,
        progress: 1,
      },
    ]);
  });
});
