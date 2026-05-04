import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  restoreDraftScope,
  restoreDraftScopeForContent,
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

  it('saves and deletes drafts with normalized request bodies', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const wrapper = createWrapper();
    const save = renderHook(() => useSaveDraft(), { wrapper });
    const del = renderHook(() => useDeleteDraft(), { wrapper });

    save.result.current.mutate({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: 'hello',
    });
    await waitFor(() => expect(save.result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts', {
      method: 'PUT',
      body: JSON.stringify({
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'hello',
        attachmentIDs: [],
      }),
    });

    del.result.current.mutate('draft-1');
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts/draft-1', {
      method: 'DELETE',
    });
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
