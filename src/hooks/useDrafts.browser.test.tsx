import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { queryKeys } from '@/lib/query-keys';
import type { Attachment, MessageDraft } from '@/types';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { ApiError } from '@/lib/api';

beforeEach(() => {
  apiFetchMock.mockReset();
  resetDraftSessionState();
});

function Probe<T>({ hook }: { hook: () => { data?: T } }) {
  const r = hook();
  return <div data-testid="probe" data-data={r.data === undefined ? '' : JSON.stringify(r.data)} />;
}

function MutationTrigger({
  hook,
  vars,
}: {
  hook: () => { mutate: (v: unknown) => void };
  vars: unknown;
}) {
  const m = hook();
  return <button data-testid="trigger" onClick={() => m.mutate(vars)} />;
}

async function renderMutation(
  hook: () => { mutate: (v: unknown) => void },
  vars: unknown,
  seed?: { key: readonly unknown[]; data: unknown },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (seed) qc.setQueryData(seed.key as readonly unknown[], seed.data);
  const screen = await render(
    <QueryClientProvider client={qc}>
      <MutationTrigger hook={hook} vars={vars} />
    </QueryClientProvider>,
  );
  return { qc, screen };
}

async function renderHook<T>(hook: () => { data?: T }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <Probe hook={hook} />
    </QueryClientProvider>,
  );
  return { qc, screen };
}

const draft = (overrides: Partial<MessageDraft> = {}): MessageDraft => ({
  id: 'd-1',
  userID: 'u-1',
  parentID: 'ch-1',
  parentType: 'channel',
  body: 'hi',
  attachmentIDs: [],
  updatedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  gen: 'g-1',
  ...overrides,
});

function conflict409(current: MessageDraft | null): ApiError {
  return new ApiError(409, 'draft changed since it was read', {
    error: { code: 'draft_conflict', message: 'draft changed since it was read' },
    current,
  });
}

describe('useDrafts — list and per-scope read', () => {
  it('useDrafts coerces a non-array API response to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const { screen } = await renderHook(() => useDrafts());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useDrafts filters rows whose generation a send condemned, keeping fresh rows in the scope', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-condemned');
    condemnDraftForSend(scope);
    apiFetchMock.mockResolvedValue([
      draft({ id: 'kept', parentID: 'ch-2', gen: 'g-other' }),
      draft({ id: 'condemned', parentID: 'ch-1', gen: 'g-condemned' }),
      // Same scope, NEW generation (typed after the send) — must survive.
      draft({ id: 'fresh', parentID: 'ch-1', gen: 'g-fresh' }),
    ]);
    const { screen } = await renderHook(() => useDrafts());
    await new Promise((r) => setTimeout(r, 150));
    const data = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') ?? '[]');
    expect(data.map((d: MessageDraft) => d.id)).toEqual(['kept', 'fresh']);
  });

  it('useDraftForScope returns the matching draft and adopts its generation as the basis', async () => {
    apiFetchMock.mockResolvedValue([
      draft({ id: 'main', parentID: 'ch-1', parentMessageID: undefined, gen: 'g-main' }),
      draft({ id: 'reply', parentID: 'ch-1', parentMessageID: 'root-1', gen: 'g-reply' }),
    ]);
    const scope = { parentID: 'ch-1', parentType: 'channel' as const, parentMessageID: 'root-1' };
    const { screen } = await renderHook(() => useDraftForScope(scope));
    await new Promise((r) => setTimeout(r, 200));
    const data = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') || 'null');
    expect(data?.id).toBe('reply');
    expect(draftBasisFor(scope)).toBe('g-reply');
  });

  it('useDraftForScope adopts the empty basis when the loaded list has no row for the scope', async () => {
    apiFetchMock.mockResolvedValue([]);
    const scope = { parentID: 'ch-none', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-stale');
    await renderHook(() => useDraftForScope(scope));
    await vi.waitFor(() => {
      expect(draftBasisFor(scope)).toBe('');
    });
  });
});

describe('useDrafts — protocol session state', () => {
  it('shouldRefetchDraftsForRemoteUpdate returns true once the local quiet window expires', () => {
    expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
  });

  it('condemnDraftForSend resets the basis, arms the echo window, and rolls back cleanly', () => {
    const scope = { parentID: 'ch-9', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-live');
    const rollback = condemnDraftForSend(scope);
    expect(draftBasisFor(scope)).toBe('');
    expect(shouldRefetchDraftsForRemoteUpdate()).toBe(false);
    rollback();
    expect(draftBasisFor(scope)).toBe('g-live');
  });

  it('condemning a scope that has no basis condemns nothing (empty-gen arm)', () => {
    const scope = { parentID: 'ch-clean', parentType: 'channel' as const };
    const rollback = condemnDraftForSend(scope);
    expect(draftBasisFor(scope)).toBe('');
    rollback();
    expect(draftBasisFor(scope)).toBe('');
  });

  it('scope helpers tolerate a scope with no parentID (draftScopeKey ?? "" side)', () => {
    const scope = { parentType: 'conversation' as const };
    adoptDraftBasis(scope, 'g-x');
    expect(draftBasisFor(scope)).toBe('g-x');
    resetDraftSessionState();
    expect(draftBasisFor(scope)).toBe('');
  });
});

describe('useDrafts — save and delete mutations', () => {
  it('useSaveDraft skips the network only for a clean-session empty flush over an empty scope', async () => {
    const { screen } = await renderMutation(useSaveDraft as never, {
      parentID: 'ch-1',
      parentType: 'channel',
      body: '',
      attachmentIDs: [],
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useSaveDraft SENDS an empty save when the session holds a basis (stranded-draft regression)', async () => {
    // The composer emptied a draft that only ever reached the server via
    // silent saves — the clear event must go out; the server decides.
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-silent');
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: '', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({ body: '', basisGen: 'g-silent' });
    expect(draftBasisFor(scope)).toBe('');
  });

  it('useSaveDraft skips the network when content AND generation match the cached draft', async () => {
    const cached: MessageDraft = draft({ id: 'd-1', body: 'hi', attachmentIDs: ['a-1'], gen: 'g-1' });
    adoptDraftBasis({ parentID: 'ch-1', parentType: 'channel' }, 'g-1');
    const { screen } = await renderMutation(
      useSaveDraft as never,
      {
        parentID: 'ch-1',
        parentType: 'channel',
        body: 'hi',
        attachmentIDs: ['a-1'],
      },
      { key: queryKeys.drafts(), data: [cached] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useSaveDraft still PUTs identical content when the session basis disagrees with the cache row', async () => {
    const cached: MessageDraft = draft({ id: 'd-1', body: 'hi', gen: 'g-cache' });
    adoptDraftBasis({ parentID: 'ch-1', parentType: 'channel' }, 'g-session');
    apiFetchMock.mockResolvedValue(draft({ id: 'd-1', body: 'hi', gen: 'g-next' }));
    const { screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'hi', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [cached] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('useSaveDraft PUTs the draft with its basis, patches the cache, and adopts the new generation', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    const saved = draft({ id: 'd-1', body: 'edited', gen: 'g-2' });
    apiFetchMock.mockResolvedValue(saved);
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      {
        parentID: 'ch-1',
        parentType: 'channel',
        body: 'edited',
        attachmentIDs: [],
        keepalive: true,
      },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts');
    const init = apiFetchMock.mock.calls[0][1] as { body: string; keepalive?: boolean };
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body).basisGen).toBe('');
    const list = qc.getQueryData<MessageDraft[]>(queryKeys.drafts()) ?? [];
    expect(list[0]?.id).toBe('d-1');
    expect(list[0]?.body).toBe('edited');
    expect(draftBasisFor(scope)).toBe('g-2');
  });

  it('useSaveDraft tolerates an omitted attachmentIDs list (coerces to [])', async () => {
    const saved = draft({ id: 'd-1', body: 'typed' });
    apiFetchMock.mockResolvedValue(saved);
    const { screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'typed' },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts');
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.attachmentIDs).toEqual([]);
  });

  it('useDraftForScope returns the main-scope draft (no parentMessageID)', async () => {
    apiFetchMock.mockResolvedValue([
      draft({ id: 'main', parentID: 'ch-1', parentMessageID: undefined }),
      draft({ id: 'reply', parentID: 'ch-1', parentMessageID: 'root-1' }),
    ]);
    const { screen } = await renderHook(() =>
      useDraftForScope({ parentID: 'ch-1', parentType: 'channel' }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const data = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') || 'null');
    expect(data?.id).toBe('main');
  });

  it('useSaveDraft compares against a cached draft whose attachmentIDs is undefined', async () => {
    // Body matches, generation matches; attachment sets differ (undefined vs
    // ['a-1']) → sortedAttachmentIDs(undefined) exercises the `ids ?? []`
    // arm and a real PUT still fires.
    const cached = draft({ id: 'd-1', body: 'same', attachmentIDs: undefined, gen: 'g-1' });
    adoptDraftBasis({ parentID: 'ch-1', parentType: 'channel' }, 'g-1');
    const saved = draft({ id: 'd-1', body: 'same', attachmentIDs: ['a-1'], gen: 'g-2' });
    apiFetchMock.mockResolvedValue(saved);
    const { screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'same', attachmentIDs: ['a-1'] },
      { key: queryKeys.drafts(), data: [cached] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts');
  });

  it('useDeleteDraft DELETEs with the displayed generation and removes the row from the cache', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { qc, screen } = await renderMutation(useDeleteDraft as never, { id: 'd-1', gen: 'g-1' }, {
      key: queryKeys.drafts(),
      data: [draft({ id: 'd-1' }), draft({ id: 'd-2' })],
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts/d-1?gen=g-1');
    const list = qc.getQueryData<MessageDraft[]>(queryKeys.drafts()) ?? [];
    expect(list.map((d) => d.id)).toEqual(['d-2']);
  });

  it('useDeleteDraft refetches the truth on a 409 conflict and leaves the cache alone on other errors', async () => {
    const current = draft({ id: 'd-1', body: 'edited elsewhere', gen: 'g-2' });
    apiFetchMock
      .mockRejectedValueOnce(conflict409(current))
      .mockResolvedValueOnce([current]); // the invalidation refetch
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    qc.setQueryData(queryKeys.drafts(), [draft({ id: 'd-1', gen: 'g-1' })]);
    function DeleteAndList() {
      const del = useDeleteDraft();
      useDrafts();
      return <button data-testid="trigger" onClick={() => del.mutate({ id: 'd-1', gen: 'g-1' })} />;
    }
    const screen = await render(
      <QueryClientProvider client={qc}>
        <DeleteAndList />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())?.[0]?.gen).toBe('g-2');
    });

    // Non-conflict error: no invalidation, cache untouched.
    apiFetchMock.mockReset();
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'boom'));
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())?.[0]?.gen).toBe('g-2');
  });

  it('removeDraftScopeFromCache drops the scope from the local cache without any network call', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.drafts(), [
      draft({ id: 'd-c', parentID: 'ch-c' }),
      draft({ id: 'd-other', parentID: 'ch-x' }),
    ]);
    removeDraftScopeFromCache(qc, { parentID: 'ch-c', parentType: 'channel' });
    expect(apiFetchMock).not.toHaveBeenCalled();
    const list = qc.getQueryData<MessageDraft[]>(queryKeys.drafts()) ?? [];
    expect(list.map((d) => d.id)).toEqual(['d-other']);
  });

  it('an empty save with attachmentIDs omitted still clears through (onSuccess ?? arm)', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-1');
    apiFetchMock.mockResolvedValue(undefined);
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      // No attachmentIDs key: the removal check's `?.length ?? 0` nullish arm.
      { parentID: 'ch-1', parentType: 'channel', body: '', silent: true },
      { key: queryKeys.drafts(), data: [draft({ id: 'd-1', body: 'was here', gen: 'g-1' })] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())).toEqual([]);
    });
    expect(draftBasisFor(scope)).toBe('');
  });

  it('useSaveDraft clearing an existing draft (server returns void) removes it from the list', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    adoptDraftBasis({ parentID: 'ch-1', parentType: 'channel' }, 'g-1');
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: '', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [draft({ id: 'd-1', body: 'was here', gen: 'g-1' })] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalled();
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())).toEqual([]);
  });

  it('useSaveDraft reconciles a 409: adopts the current generation and patches the truth into the cache', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-stale');
    const current = draft({ id: 'd-1', body: 'written elsewhere', gen: 'g-elsewhere' });
    apiFetchMock.mockRejectedValueOnce(conflict409(current));
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'mine', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(draftBasisFor(scope)).toBe('g-elsewhere');
    });
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())?.map((d) => d.id)).toEqual(['d-1']);
  });

  it('useSaveDraft reconciles a 409 whose current is null (scope cleared elsewhere)', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-ghost');
    apiFetchMock.mockRejectedValueOnce(conflict409(null));
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: '', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [draft({ id: 'd-1', gen: 'g-ghost' })] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(draftBasisFor(scope)).toBe('');
    });
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())).toEqual([]);
  });

  it('useSaveDraft ignores a 409 that a send already outdated, and non-conflict errors entirely', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-live');
    let rejectSave: (e: unknown) => void = () => {};
    apiFetchMock.mockImplementationOnce(() => new Promise((_res, rej) => { rejectSave = rej; }));
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'typed pre-send', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    // The send condemns the scope while the save is in flight.
    condemnDraftForSend(scope);
    rejectSave(conflict409(draft({ id: 'd-ghost', body: 'typed pre-send', gen: 'g-ghost' })));
    await new Promise((r) => setTimeout(r, 200));
    // The outdated conflict changed nothing.
    expect(draftBasisFor(scope)).toBe('');
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())).toEqual([]);

    // A non-conflict error also leaves the session state alone.
    adoptDraftBasis(scope, 'g-live2');
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(draftBasisFor(scope)).toBe('g-live2');
  });

  it('useSaveDraft ignores non-draft 409s (no draft_conflict code)', async () => {
    const scope = { parentID: 'ch-1', parentType: 'channel' as const };
    adoptDraftBasis(scope, 'g-live');
    apiFetchMock.mockRejectedValueOnce(new ApiError(409, 'thread deleted', { error: { code: 'thread_deleted' } }));
    const { screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'x', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(draftBasisFor(scope)).toBe('g-live');
  });

  it('useSaveDraft drops a stale mutation whose version was superseded', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.drafts(), [] as MessageDraft[]);
    let resolveFirst: (v: MessageDraft) => void = () => {};
    apiFetchMock
      .mockImplementationOnce(
        () => new Promise<MessageDraft>((res) => { resolveFirst = res; }),
      )
      .mockImplementationOnce(() => Promise.resolve(draft({ id: 'd-2', body: 'second', gen: 'g-2' })));

    function TwoSaves() {
      const save = useSaveDraft();
      return (
        <button
          data-testid="trigger"
          onClick={() => {
            save.mutate({ parentID: 'ch-1', parentType: 'channel', body: 'first', attachmentIDs: [] });
            save.mutate({ parentID: 'ch-1', parentType: 'channel', body: 'second', attachmentIDs: [] });
          }}
        />
      );
    }
    const screen = await render(
      <QueryClientProvider client={qc}>
        <TwoSaves />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 150));
    // Second save resolved and patched the cache.
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())?.[0]?.id).toBe('d-2');
    // Now resolve the first (now-stale) save — its onSuccess must NOT
    // overwrite the cache or regress the adopted basis.
    resolveFirst(draft({ id: 'd-1', body: 'first', gen: 'g-1' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())?.[0]?.id).toBe('d-2');
    expect(draftBasisFor({ parentID: 'ch-1', parentType: 'channel' })).toBe('g-2');
  });
});

describe('useDrafts — useDraftAttachmentChips', () => {
  function ChipsProbe({ ids }: { ids: string[] | undefined }) {
    const chips = useDraftAttachmentChips(ids);
    return (
      <div data-testid="chips" data-ids={chips.map((c: DraftAttachment) => c.id).join(',')} />
    );
  }

  it('maps resolved attachments to chips and skips ids with no attachment', async () => {
    const attachment: Attachment = {
      id: 'a-1',
      sha256: 'x',
      size: 10,
      contentType: 'image/png',
      filename: 'pic.png',
      url: 'blob:pic',
      squareThumbnailURL: 'blob:thumb',
      createdBy: 'u-1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    apiFetchMock.mockResolvedValue([attachment]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <ChipsProbe ids={['a-1', 'a-missing']} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId('chips').element().getAttribute('data-ids')).toBe('a-1');
    });
  });

  it('returns no chips when given no attachment ids', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <ChipsProbe ids={undefined} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('chips').element().getAttribute('data-ids')).toBe('');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
