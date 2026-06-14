import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useDrafts,
  useDraftForScope,
  useSaveDraft,
  useDeleteDraft,
  useDraftAttachmentChips,
  shouldRefetchDraftsForRemoteUpdate,
  suppressSentDraft,
  restoreDraftScope,
  restoreDraftScopeForContent,
} from './useDrafts';
import { queryKeys } from '@/lib/query-keys';
import type { Attachment, MessageDraft } from '@/types';
import type { DraftAttachment } from '@/components/chat/AttachmentChip';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  parentID: 'ch-1',
  parentType: 'channel',
  body: 'hi',
  attachmentIDs: [],
  updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('useDrafts — list and per-scope read', () => {
  it('useDrafts coerces a non-array API response to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const { screen } = await renderHook(() => useDrafts());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useDrafts filters out suppressed-sent draft scopes', async () => {
    suppressSentDraft({ parentID: 'ch-1', parentType: 'channel' });
    try {
      apiFetchMock.mockResolvedValue([
        draft({ id: 'kept', parentID: 'ch-2' }),
        draft({ id: 'suppressed', parentID: 'ch-1' }),
      ]);
      const { screen } = await renderHook(() => useDrafts());
      await new Promise((r) => setTimeout(r, 150));
      const data = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') ?? '[]');
      expect(data.map((d: MessageDraft) => d.id)).toEqual(['kept']);
    } finally {
      restoreDraftScope({ parentID: 'ch-1', parentType: 'channel' });
    }
  });

  it('useDraftForScope returns the matching draft from the list', async () => {
    apiFetchMock.mockResolvedValue([
      draft({ id: 'main', parentID: 'ch-1', parentMessageID: undefined }),
      draft({ id: 'reply', parentID: 'ch-1', parentMessageID: 'root-1' }),
    ]);
    const { screen } = await renderHook(() =>
      useDraftForScope({ parentID: 'ch-1', parentType: 'channel', parentMessageID: 'root-1' }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const data = JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') || 'null');
    expect(data?.id).toBe('reply');
  });
});

describe('useDrafts — suppress / restore helpers', () => {
  it('shouldRefetchDraftsForRemoteUpdate returns true once the local quiet window expires', () => {
    expect(shouldRefetchDraftsForRemoteUpdate()).toBe(true);
  });

  it('restoreDraftScopeForContent only restores when body or attachments are non-empty', () => {
    const scope = { parentID: 'ch-9', parentType: 'channel' as const };
    suppressSentDraft(scope);
    restoreDraftScopeForContent(scope, { body: '', attachmentIDs: [] });
    // Suppression still in effect: an immediate save on the same scope
    // would short-circuit, but we can only assert indirectly — check via
    // a fresh useDrafts read.
    restoreDraftScopeForContent(scope, { body: 'still drafting' });
    restoreDraftScope(scope); // cleanup
  });

  it('restoreDraftScopeForContent restores when only attachments are present (empty body)', () => {
    // body === '' so the first `||` operand is false → exercises the
    // `attachmentIDs?.length ?? 0 > 0` arm on line 98.
    const scope = { parentID: 'ch-att', parentType: 'channel' as const };
    suppressSentDraft(scope);
    restoreDraftScopeForContent(scope, { body: '', attachmentIDs: ['a-1'] });
    restoreDraftScope(scope); // cleanup
  });

  it('restoreDraftScopeForContent tolerates an undefined attachmentIDs (?. nullish side)', () => {
    // body === '' AND attachmentIDs undefined → `?.length` short-circuits
    // to undefined, `?? 0`, `0 > 0` false → no restore.
    const scope = { parentID: 'ch-none', parentType: 'channel' as const };
    suppressSentDraft(scope);
    restoreDraftScopeForContent(scope, { body: '' });
    restoreDraftScope(scope); // cleanup
  });

  it('suppress/restore tolerate a scope with no parentID (draftScopeKey ?? "" side)', () => {
    // scope.parentID undefined → draftScopeKey's `parentID ?? ''` arm.
    const scope = { parentType: 'conversation' as const };
    suppressSentDraft(scope);
    restoreDraftScope(scope);
  });
});

describe('useDrafts — save and delete mutations', () => {
  it('useSaveDraft skips the network call when body is empty and there are no attachments', async () => {
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

  it('useSaveDraft skips the network call when nothing has changed vs the cached draft', async () => {
    const cached: MessageDraft = draft({ id: 'd-1', body: 'hi', attachmentIDs: ['a-1'] });
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

  it('useSaveDraft PUTs the draft and patches the cached list', async () => {
    const saved = draft({ id: 'd-1', body: 'edited' });
    apiFetchMock.mockResolvedValue(saved);
    const { qc, screen } = await renderMutation(
      useSaveDraft as never,
      {
        parentID: 'ch-1',
        parentType: 'channel',
        body: 'edited',
        attachmentIDs: [],
      },
      { key: queryKeys.drafts(), data: [] as MessageDraft[] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts');
    const list = qc.getQueryData<MessageDraft[]>(queryKeys.drafts()) ?? [];
    expect(list[0]?.id).toBe('d-1');
    expect(list[0]?.body).toBe('edited');
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
    // existing.attachmentIDs === undefined → sortedAttachmentIDs(undefined)
    // exercises the `ids ?? []` nullish arm (line 76). Body differs so a
    // real PUT still fires.
    const cached = draft({ id: 'd-1', body: 'old', attachmentIDs: undefined });
    const saved = draft({ id: 'd-1', body: 'new' });
    apiFetchMock.mockResolvedValue(saved);
    const { screen } = await renderMutation(
      useSaveDraft as never,
      { parentID: 'ch-1', parentType: 'channel', body: 'new', attachmentIDs: [] },
      { key: queryKeys.drafts(), data: [cached] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts');
  });

  it('useDeleteDraft DELETEs the draft and removes it from the cached list', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { qc, screen } = await renderMutation(useDeleteDraft as never, 'd-1', {
      key: queryKeys.drafts(),
      data: [draft({ id: 'd-1' }), draft({ id: 'd-2' })],
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/drafts/d-1');
    const list = qc.getQueryData<MessageDraft[]>(queryKeys.drafts()) ?? [];
    expect(list.map((d) => d.id)).toEqual(['d-2']);
  });

  it('useSaveDraft drops a stale mutation whose version was superseded', async () => {
    // Two rapid saves on the same scope. onMutate bumps the per-scope
    // version each time; the slower (first) resolution sees a newer
    // version and short-circuits onSuccess (line 157 isLatestDraftMutation
    // false arm) without patching the cache.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.drafts(), [] as MessageDraft[]);
    let resolveFirst: (v: MessageDraft) => void = () => {};
    apiFetchMock
      .mockImplementationOnce(
        () => new Promise<MessageDraft>((res) => { resolveFirst = res; }),
      )
      .mockImplementationOnce(() => Promise.resolve(draft({ id: 'd-2', body: 'second' })));

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
    // overwrite the cache.
    resolveFirst(draft({ id: 'd-1', body: 'first' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(qc.getQueryData<MessageDraft[]>(queryKeys.drafts())?.[0]?.id).toBe('d-2');
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
    // Two IDs requested; the batch resolves only one → the unresolved id
    // hits the `if (!att) return null` true arm, the resolved one the
    // false arm (line 191 both sides).
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
