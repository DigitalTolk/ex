import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  adoptDraftBasis,
  condemnDraftForSend,
  draftBasisFor,
  removeDraftScopeFromCache,
  resetDraftSessionState,
  shouldRefetchDraftsForRemoteUpdate,
  useDeleteDraft,
  useDraftAttachmentChips,
  useDraftForScope,
  useDrafts,
  useSaveDraft,
} from './useDrafts';
import type { MessageDraft } from '@/types';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { ApiError, apiFetch } from '@/lib/api';

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

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function makeDraft(over: Partial<MessageDraft> & { id: string }): MessageDraft {
  return {
    userID: 'u-1',
    parentID: 'dm-1',
    parentType: 'conversation',
    parentMessageID: '',
    body: '',
    attachmentIDs: [],
    updatedAt: '2026-05-03T10:00:00Z',
    createdAt: '2026-05-03T10:00:00Z',
    gen: `g-${over.id}`,
    ...over,
  };
}

function conflict409(current: MessageDraft | null): ApiError {
  return new ApiError(409, 'draft changed since it was read', {
    error: { code: 'draft_conflict', message: 'draft changed since it was read' },
    current,
  });
}

describe('useDrafts', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    resetDraftSessionState();
  });

  it('resetDraftSessionState clears bases, condemned gens and the ignore window', () => {
    const scope = { parentID: 'reset-me', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-live');
    condemnDraftForSend(scope);
    resetDraftSessionState();
    expect(draftBasisFor(scope)).toBe('');
    // ignoreDraftEventsUntil reset to 0 → remote draft updates are processed again.
    expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
  });

  it('loads drafts and normalizes invalid responses to an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ nope: true });

    const { result } = renderHook(() => useDrafts(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts');
    expect(result.current.data).toEqual([]);
  });

  it('returns the draft matching the exact composer scope and adopts its generation as the session basis', async () => {
    const drafts: MessageDraft[] = [
      makeDraft({ id: 'draft-1', parentID: 'ch-1', parentType: 'channel', body: 'main draft' }),
      makeDraft({ id: 'draft-2', parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root-1', body: 'thread draft' }),
    ];
    vi.mocked(apiFetch).mockResolvedValue(drafts);

    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    const { result } = renderHook(() => useDraftForScope(scope), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('draft-1');
    // The composer acts on what it displays: the basis follows the cache.
    await waitFor(() => expect(draftBasisFor(scope)).toBe('g-draft-1'));
  });

  it('adopts the empty basis when the loaded cache has no draft for the scope', async () => {
    vi.mocked(apiFetch).mockResolvedValue([]);
    const scope = { parentID: 'ch-empty', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-stale-from-last-visit');

    const { result } = renderHook(() => useDraftForScope(scope), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Server truth: no draft → the stale basis is dropped, so a later flush
    // can't present a generation the server no longer stores.
    await waitFor(() => expect(draftBasisFor(scope)).toBe(''));
  });

  it('matches a thread-scoped draft and tolerates drafts missing parentMessageID', async () => {
    const drafts: MessageDraft[] = [
      // parentMessageID intentionally undefined → exercises the `?? ''` fallback.
      makeDraft({ id: 'd-undef', parentID: 'ch-1', parentType: 'channel', parentMessageID: undefined, body: 'no thread field' }),
      makeDraft({ id: 'd-thread', parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root-9', body: 'thread draft' }),
    ];
    vi.mocked(apiFetch).mockResolvedValue(drafts);

    const { result } = renderHook(
      () => useDraftForScope({ parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root-9' }),
      { wrapper: createWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe('d-thread');
  });

  it('filters rows whose generation a send condemned, but never a NEW draft in the same scope', async () => {
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    const sent = makeDraft({ id: 'draft-sent', body: 'already sent', gen: 'g-sent' });
    const fresh = makeDraft({ id: 'draft-fresh', body: 'typed after the send', gen: 'g-fresh' });

    adoptDraftBasis(scope, 'g-sent');
    condemnDraftForSend(scope);

    // A refetch racing the send's async server-side fold still returns the
    // old row — it must not resurface. A row with a NEW generation (a draft
    // created after the send) must.
    vi.mocked(apiFetch).mockResolvedValue([sent, fresh]);
    const { result } = renderHook(() => useDrafts(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([fresh]);
  });

  it('condemnDraftForSend resets the basis and its rollback restores everything on a failed send', async () => {
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    const sent = makeDraft({ id: 'draft-sent', body: 'draft', gen: 'g-sent' });
    adoptDraftBasis(scope, 'g-sent');

    const rollback = condemnDraftForSend(scope);
    expect(draftBasisFor(scope)).toBe('');
    // The fold's own echo is ignored while in flight.
    expect(shouldRefetchDraftsForRemoteUpdate()).toBe(false);

    // Send failed → the fold never ran server-side: the draft still exists,
    // so the basis and the row's visibility come back.
    rollback();
    expect(draftBasisFor(scope)).toBe('g-sent');
    vi.mocked(apiFetch).mockResolvedValue([sent]);
    const { result } = renderHook(() => useDrafts(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([sent]);
  });

  it('condemning a scope with no basis condemns nothing', () => {
    const scope = { parentID: 'dm-clean', parentType: 'conversation' as const };
    const rollback = condemnDraftForSend(scope);
    expect(draftBasisFor(scope)).toBe('');
    rollback();
    expect(draftBasisFor(scope)).toBe('');
  });

  it('removeDraftScopeFromCache drops the scope from the local cache without any network call', () => {
    const qc = makeQC();
    qc.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'keep', parentID: 'ch-x', parentType: 'channel', body: 'keep' }),
      makeDraft({ id: 'go', parentID: 'dm-1', parentType: 'conversation', body: 'go' }),
    ]);
    removeDraftScopeFromCache(qc, { parentID: 'dm-1', parentType: 'conversation' });
    expect(apiFetch).not.toHaveBeenCalled();
    expect((qc.getQueryData<MessageDraft[]>(['drafts']) ?? []).map((d) => d.id)).toEqual(['keep']);
  });

  it('saves carry the session basis generation and adopt the server-minted one from the response', async () => {
    const qc = makeQC();
    qc.setQueryData<MessageDraft[]>(['drafts'], []);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    vi.mocked(apiFetch).mockResolvedValue(makeDraft({ id: 'd-1', body: 'hello', gen: 'g-new' }));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(qc) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'hello' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts', {
      method: 'PUT',
      keepalive: undefined,
      body: JSON.stringify({
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'hello',
        attachmentIDs: [],
        // A default (non-silent) save broadcasts so the sidebar indicator shows.
        notify: true,
        // First save of the session: "I believe no draft exists".
        basisGen: '',
      }),
    });
    // The accepted write's generation becomes the session basis.
    expect(draftBasisFor(scope)).toBe('g-new');
  });

  it('REGRESSION: emptying a silently-saved draft reaches the server (no cache-blind skip)', async () => {
    // The original resurrection bug: silent keystroke saves never patch the
    // cache, so the old "skip the empty save when the cache has no row" check
    // dropped the clear entirely — the draft lived on server-side and came
    // back on the next refetch. With generation bases the clear must be SENT.
    const qc = makeQC();
    qc.setQueryData<MessageDraft[]>(['drafts'], []);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(makeDraft({ id: 'd-1', body: 'typed', gen: 'g-1' })) // silent keystroke save
      .mockResolvedValueOnce(undefined); // the clear (204)

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(qc) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'typed', silent: true }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1));
    // Cache untouched by the silent save — exactly the old blind spot.
    expect(qc.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);

    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: '', attachmentIDs: [], silent: true }));
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2));
    const clearCall = vi.mocked(apiFetch).mock.calls[1];
    expect(clearCall[0]).toBe('/api/v1/drafts');
    const body = JSON.parse((clearCall[1] as RequestInit).body as string) as { body: string; basisGen: string };
    // The clear presents the generation the silent save minted.
    expect(body).toMatchObject({ body: '', basisGen: 'g-1' });
    expect(draftBasisFor(scope)).toBe('');
  });

  it('skips the network only for a clean-session empty flush over an empty scope', async () => {
    const qc = makeQC();
    qc.setQueryData<MessageDraft[]>(['drafts'], []);
    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(qc) });
    // No basis, no cached row, nothing typed: there is nothing to tell the
    // server ("am I cleared?" would be answered by the fetch that already ran).
    await act(async () => {
      await result.current.mutateAsync({ parentID: 'dm-untouched', parentType: 'conversation', body: '' });
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('passes keepalive through so teardown flushes survive the page dying', async () => {
    vi.mocked(apiFetch).mockResolvedValue(makeDraft({ id: 'd-1', body: 'bye', gen: 'g-1' }));
    const { result } = renderHook(() => useSaveDraft(), { wrapper: createWrapper() });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'bye', keepalive: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts', expect.objectContaining({ keepalive: true }));
  });

  it('patches the drafts cache by scope after saves and empty clears', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-old', body: 'old', gen: 'g-old' }),
      makeDraft({ id: 'draft-other', parentID: 'dm-2', body: 'other' }),
    ]);
    adoptDraftBasis({ parentID: 'dm-1', parentType: 'conversation' }, 'g-old');
    const saved = makeDraft({ id: 'draft-new', body: 'new', gen: 'g-new' });
    vi.mocked(apiFetch).mockResolvedValueOnce(saved).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'new' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((draft) => draft.id)).toEqual([
      'draft-new',
      'draft-other',
    ]);

    result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: '', attachmentIDs: [] });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((draft) => draft.id)).toEqual([
        'draft-other',
      ]);
    });
  });

  it('a silent save persists with notify:false but does NOT surface the draft in the sidebar cache', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    const saved = makeDraft({ id: 'draft-typing', body: 'typing…', gen: 'g-typing' });
    vi.mocked(apiFetch).mockResolvedValue(saved);

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'typing…', silent: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Request carried notify:false…
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts', {
      method: 'PUT',
      keepalive: undefined,
      body: JSON.stringify({
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: 'typing…',
        attachmentIDs: [],
        notify: false,
        basisGen: '',
      }),
    });
    // …and the local list stays empty (no sidebar indicator yet).
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);
  });

  it('a silent save that EMPTIES the draft removes it from the sidebar cache immediately', async () => {
    // Emptying the composer fires a silent keystroke save. That is a removal,
    // not a surface, so the sidebar badge must clear at once instead of
    // lingering until focus loss / channel switch.
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-existing', body: 'lingering', gen: 'g-existing' }),
      makeDraft({ id: 'draft-other', parentID: 'dm-2', body: 'other' }),
    ]);
    adoptDraftBasis({ parentID: 'dm-1', parentType: 'conversation' }, 'g-existing');
    // Server deletes the now-empty draft and returns 204 (nil draft).
    vi.mocked(apiFetch).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: '', attachmentIDs: [], silent: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The silent empty save still hit the server with notify:false…
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts', {
      method: 'PUT',
      keepalive: undefined,
      body: JSON.stringify({
        parentID: 'dm-1',
        parentType: 'conversation',
        parentMessageID: '',
        body: '',
        attachmentIDs: [],
        notify: false,
        basisGen: 'g-existing',
      }),
    });
    // …and the lingering draft is dropped from the cache right away.
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((draft) => draft.id)).toEqual([
      'draft-other',
    ]);
  });

  it('does not PUT a duplicate save when content and generation both match the cache', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-1', body: 'same', attachmentIDs: ['a-2', 'a-1'], gen: 'g-1' }),
    ]);
    adoptDraftBasis({ parentID: 'dm-1', parentType: 'conversation' }, 'g-1');
    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });

    await result.current.mutateAsync({
      parentID: 'dm-1',
      parentType: 'conversation',
      body: 'same',
      attachmentIDs: ['a-1', 'a-2'],
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('DOES resend identical content when the session basis disagrees with the cache row', async () => {
    // Cache and session drifted (e.g. a stale refetch): the dedupe must not
    // swallow the save, or the drift never heals — the server arbitrates.
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-1', body: 'same', gen: 'g-cache' }),
    ]);
    adoptDraftBasis({ parentID: 'dm-1', parentType: 'conversation' }, 'g-session');
    vi.mocked(apiFetch).mockResolvedValue(makeDraft({ id: 'draft-1', body: 'same', gen: 'g-next' }));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    await result.current.mutateAsync({ parentID: 'dm-1', parentType: 'conversation', body: 'same', attachmentIDs: [] });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('reconciles a 409 conflict: adopts the current generation and patches the cache with the truth', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-stale');
    const current = makeDraft({ id: 'draft-1', body: 'written elsewhere', gen: 'g-elsewhere' });
    vi.mocked(apiFetch).mockRejectedValueOnce(conflict409(current));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'mine' }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Session basis: the truth's generation → the user's NEXT save/flush is
    // a deliberate, accepted overwrite instead of an eternal conflict.
    expect(draftBasisFor(scope)).toBe('g-elsewhere');
    // Cache: the server's row, so un-edited composers mirror it.
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((d) => d.id)).toEqual(['draft-1']);
  });

  it('does not reconcile a 409 whose payload is not a draft_conflict', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-stale');
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError(409, 'some other conflict', { error: { code: 'not_a_draft_conflict' } }),
    );

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'mine' }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // Foreign 409s must not touch the basis or cache — only the draft
    // protocol's own conflicts reconcile.
    expect(draftBasisFor(scope)).toBe('g-stale');
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);
  });

  it('reconciles a 409 with a null current (the scope was cleared elsewhere)', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-1', body: 'ghost', gen: 'g-ghost' }),
    ]);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-ghost');
    vi.mocked(apiFetch).mockRejectedValueOnce(conflict409(null));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: '', attachmentIDs: [] }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(draftBasisFor(scope)).toBe('');
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);
  });

  it('ignores a 409 from a save the send already outdated (no resurrection through reconcile)', async () => {
    // The race the old client-clock design could not close: a keystroke save
    // is in flight when the user hits send. The send condemns the scope; when
    // the stale save's conflict lands, it must NOT re-adopt or re-patch —
    // that would resurrect the just-sent draft through the reconcile path.
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-live');

    let rejectSave!: (err: unknown) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(
      new Promise((_resolve, reject) => { rejectSave = reject; }),
    );
    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'typed pre-send' }));

    // User hits send while the save is in flight.
    condemnDraftForSend(scope);

    const ghost = makeDraft({ id: 'draft-ghost', body: 'typed pre-send', gen: 'g-ghost' });
    rejectSave(conflict409(ghost));
    await waitFor(() => expect(result.current.isError).toBe(true));

    // The outdated save's conflict changed nothing.
    expect(draftBasisFor(scope)).toBe('');
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);
  });

  it('treats a draft-conflict payload with no current field as an empty scope', async () => {
    // The 409 body omits `current` when serializers drop nulls — the client
    // must read that as "no draft" (?? null), not choke or keep stale state.
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-1', body: 'ghost', gen: 'g-ghost' }),
    ]);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-ghost');
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError(409, 'draft changed since it was read', {
        error: { code: 'draft_conflict', message: 'draft changed since it was read' },
      }),
    );

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'mine' }));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(draftBasisFor(scope)).toBe('');
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);
  });

  it('leaves state untouched on non-conflict save errors (next flush retries)', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    const scope = { parentID: 'dm-1', parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-live');
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError(500, 'boom'));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    act(() => result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'keep me' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(draftBasisFor(scope)).toBe('g-live');
  });

  it('ignores stale draft save responses for the same scope', async () => {
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], []);
    let resolveFirst!: (draft: MessageDraft) => void;
    vi.mocked(apiFetch)
      .mockReturnValueOnce(new Promise<MessageDraft>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(makeDraft({ id: 'draft-new', body: 'new', gen: 'g-new' }));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });
    const first = result.current.mutateAsync({ parentID: 'dm-1', parentType: 'conversation', body: 'old' });
    const second = result.current.mutateAsync({ parentID: 'dm-1', parentType: 'conversation', body: 'new' });
    await second;
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.[0]?.body).toBe('new');
    expect(draftBasisFor({ parentID: 'dm-1', parentType: 'conversation' })).toBe('g-new');

    await act(async () => {
      resolveFirst(makeDraft({ id: 'draft-old', body: 'old', gen: 'g-old' }));
      await first;
    });
    // The stale response neither patches the cache nor regresses the basis.
    expect(queryClient.getQueryData<MessageDraft[]>(['drafts'])?.map((d) => d.body)).toEqual(['new']);
    expect(draftBasisFor({ parentID: 'dm-1', parentType: 'conversation' })).toBe('g-new');
  });

  it('temporarily suppresses self-generated draft.updated refetches', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(9_999_999_999_999);
      vi.mocked(apiFetch).mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useSaveDraft(), { wrapper: createWrapper() });

      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
      act(() => {
        result.current.mutate({ parentID: 'dm-1', parentType: 'conversation', body: 'draft' });
      });
      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(false);

      vi.setSystemTime(10_000_000_001_500);
      expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dedups against a cached legacy draft that omits parentMessageID and attachmentIDs', async () => {
    // The cached row has parentMessageID and attachmentIDs undefined,
    // exercising the `?? ''` scope fallback (sameDraftScope) and the `?? []`
    // fallback (sortedAttachmentIDs) when comparing the incoming save.
    const queryClient = makeQC();
    queryClient.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-bare', parentID: 'dm-9', parentMessageID: undefined, attachmentIDs: undefined, body: 'same', gen: 'legacy' }),
    ]);
    adoptDraftBasis({ parentID: 'dm-9', parentType: 'conversation' }, 'legacy');
    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(queryClient) });

    // Identical body + no attachments → matches the cached draft, so no PUT fires.
    await result.current.mutateAsync({ parentID: 'dm-9', parentType: 'conversation', body: 'same' });

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('useDeleteDraft sends the displayed generation and refetches the truth on conflict', async () => {
    const qc = makeQC();
    const stale = makeDraft({ id: 'draft-1', body: 'delete me', gen: 'g-1' });
    const current = makeDraft({ id: 'draft-1', body: 'edited elsewhere', gen: 'g-2' });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce([stale]) // initial list fetch
      .mockResolvedValueOnce(undefined) // first delete succeeds
      .mockRejectedValueOnce(conflict409(current)) // second delete: stale page
      .mockResolvedValueOnce([current]); // conflict-triggered refetch: the truth

    // Mount the list alongside so the conflict-triggered invalidation has an
    // active observer to refetch through (as the Drafts page does).
    const { result } = renderHook(
      () => ({ del: useDeleteDraft(), list: useDrafts() }),
      { wrapper: wrapperFor(qc) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    act(() => result.current.del.mutate({ id: 'draft-1', gen: 'g-1' }));
    await waitFor(() => expect(result.current.del.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/drafts/draft-1?gen=g-1', { method: 'DELETE' });
    expect(qc.getQueryData<MessageDraft[]>(['drafts'])).toEqual([]);

    // Stale page: the row changed since it rendered → 409 → refetch truth.
    act(() => result.current.del.mutate({ id: 'draft-1', gen: 'g-1' }));
    await waitFor(() => expect(result.current.del.isError).toBe(true));
    await waitFor(() => {
      expect(qc.getQueryData<MessageDraft[]>(['drafts'])?.[0]?.gen).toBe('g-2');
    });
  });

  it('useDeleteDraft leaves the cache alone on non-conflict errors', async () => {
    const qc = makeQC();
    qc.setQueryData<MessageDraft[]>(['drafts'], [
      makeDraft({ id: 'draft-1', body: 'keep', gen: 'g-1' }),
    ]);
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiError(500, 'boom'));
    const { result } = renderHook(() => useDeleteDraft(), { wrapper: wrapperFor(qc) });
    act(() => result.current.mutate({ id: 'draft-1', gen: 'g-1' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<MessageDraft[]>(['drafts'])?.map((d) => d.id)).toEqual(['draft-1']);
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

  it('version guard: only the newest concurrent save patches the cache, even when older saves resolve last', async () => {
    const qc = makeQC();
    qc.setQueryData<MessageDraft[]>(['drafts'], []);

    const draft = (body: string, gen: string): MessageDraft =>
      makeDraft({ id: `d-${body}`, parentID: 'dm-lww', body, gen });

    // The two OLDER saves stay pending; the newest resolves immediately.
    let resolveV1!: (d: MessageDraft) => void;
    let resolveV2!: (d: MessageDraft) => void;
    vi.mocked(apiFetch)
      .mockReturnValueOnce(new Promise<MessageDraft>((r) => { resolveV1 = r; }))
      .mockReturnValueOnce(new Promise<MessageDraft>((r) => { resolveV2 = r; }))
      .mockResolvedValueOnce(draft('three', 'g-3'));

    const { result } = renderHook(() => useSaveDraft(), { wrapper: wrapperFor(qc) });
    // Three concurrent saves on the SAME scope → versions 1, 2, 3.
    const p1 = result.current.mutateAsync({ parentID: 'dm-lww', parentType: 'conversation', body: 'one' });
    const p2 = result.current.mutateAsync({ parentID: 'dm-lww', parentType: 'conversation', body: 'two' });
    const p3 = result.current.mutateAsync({ parentID: 'dm-lww', parentType: 'conversation', body: 'three' });

    // The newest (v3) resolves first and wins the cache.
    await p3;
    expect(qc.getQueryData<MessageDraft[]>(['drafts'])?.[0]?.body).toBe('three');

    // Now the two STALE saves resolve LAST. Their onSuccess must be ignored by
    // the version guard (isLatestDraftMutation) — the newer value must survive.
    await act(async () => {
      resolveV2(draft('two', 'g-2'));
      resolveV1(draft('one', 'g-1'));
      await p2;
      await p1;
    });
    expect(qc.getQueryData<MessageDraft[]>(['drafts'])?.map((d) => d.body)).toEqual(['three']);
    expect(draftBasisFor({ parentID: 'dm-lww', parentType: 'conversation' })).toBe('g-3');
  });
});
