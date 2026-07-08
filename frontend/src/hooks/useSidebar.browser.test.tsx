import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
} from './useSidebar';
import type { SidebarReorderUpdate } from '@/lib/sidebar-reorder';
import { queryKeys } from '@/lib/query-keys';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
  try { localStorage.removeItem('ex.sidebarDndDebug'); } catch { /* noop */ }
});

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

function renderQuery<T>(hook: () => { data?: T }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    const r = hook();
    return <div data-testid="probe" data-data={r.data === undefined ? '' : JSON.stringify(r.data)} />;
  }
  return render(
    <QueryClientProvider client={qc}>
      <Probe />
    </QueryClientProvider>,
  );
}

describe('useSidebar — categories', () => {
  it('useCategories coerces non-array response to []', async () => {
    apiFetchMock.mockResolvedValue(null);
    const screen = await renderQuery(() => useCategories());
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('[]');
  });

  it('useCategories returns the array response as-is', async () => {
    apiFetchMock.mockResolvedValue([{ id: 'c-1', name: 'work', position: 1 }]);
    const screen = await renderQuery(() => useCategories());
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(screen.getByTestId('probe').element().getAttribute('data-data') ?? '[]')).toEqual([
      { id: 'c-1', name: 'work', position: 1 },
    ]);
  });

  it('useUpdateCategory optimistic patch is a no-op when the categories cache is empty', async () => {
    // No seeded cache → current is undefined, so the map short-circuits
    // to the `?? current` arm (current?.map nullish branch).
    apiFetchMock.mockResolvedValue({ id: 'c-1', name: 'renamed', position: 1 });
    const { qc, screen } = await renderMutation(useUpdateCategory as never, { id: 'c-1', name: 'renamed' });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(qc.getQueryData(queryKeys.sidebarCategories())).toBeUndefined();
  });

  it('useCreateCategory POSTs to /sidebar/categories', async () => {
    apiFetchMock.mockResolvedValue({ id: 'c-1', name: 'work', position: 1 });
    const { screen } = await renderMutation(useCreateCategory as never, 'work');
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/sidebar/categories');
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({ name: 'work' });
  });

  it('useUpdateCategory PATCHes /sidebar/categories/:id with the new name', async () => {
    apiFetchMock.mockResolvedValue({});
    const { screen } = await renderMutation(
      useUpdateCategory as never,
      { id: 'c-1', name: 'renamed' },
      { key: queryKeys.sidebarCategories(), data: [{ id: 'c-1', name: 'old', position: 1 }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/sidebar/categories/c-1');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('PATCH');
  });

  it('useReorderCategories 409 conflict rolls back and marks the list stale', async () => {
    const { ApiError: RealApiError } = await import('@/lib/api');
    apiFetchMock.mockRejectedValueOnce(new RealApiError(409, 'sidebar: layout changed since it was read', {
      error: { code: 'sidebar_conflict', message: 'sidebar: layout changed since it was read' },
    }));
    const before = [
      { id: 'c-1', name: 'a', position: 1024 },
      { id: 'c-2', name: 'b', position: 2048 },
    ];
    const { qc, screen } = await renderMutation(
      useReorderCategories as never,
      { categories: [before[1], before[0]], movedID: 'c-2', afterID: '' },
      { key: queryKeys.sidebarCategories(), data: before },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(qc.getQueryState(queryKeys.sidebarCategories())?.isInvalidated).toBe(true);
    });
    expect(qc.getQueryData(queryKeys.sidebarCategories())).toEqual(before);
  });

  it('useReorderCategories tolerates a bodyless move response (categories ?? [])', async () => {
    apiFetchMock.mockResolvedValueOnce({});
    const { qc, screen } = await renderMutation(
      useReorderCategories as never,
      { categories: [{ id: 'c-1', name: 'a', position: 1000 }], movedID: 'c-1', afterID: '' },
      { key: queryKeys.sidebarCategories(), data: [{ id: 'c-1', name: 'a', position: 1000 }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(qc.getQueryData(queryKeys.sidebarCategories())).toEqual([]);
    });
  });

  it('useReorderCategories reports ONE move event and applies the server order as truth', async () => {
    const serverOrder = [
      { id: 'c-2', name: 'b', position: 1024 },
      { id: 'c-1', name: 'a', position: 2048 },
    ];
    apiFetchMock.mockResolvedValue({ categories: serverOrder });
    const { qc, screen } = await renderMutation(
      useReorderCategories as never,
      {
        categories: [
          { id: 'c-2', name: 'b', position: 999 },
          { id: 'c-1', name: 'a', position: 999 },
        ],
        movedID: 'c-2',
        afterID: '',
      },
      { key: queryKeys.sidebarCategories(), data: [] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    // One event-shaped request; no client-computed positions on the wire.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/sidebar/categories/c-2/move');
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({ afterID: '' });
    // The server's canonical order replaced the optimistic preview.
    expect(qc.getQueryData(queryKeys.sidebarCategories())).toEqual(serverOrder);
  });

  it('useDeleteCategory DELETEs the category', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useDeleteCategory as never, 'c-1');
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/sidebar/categories/c-1');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
  });
});

describe('useSidebar — favorite/category attribute setters', () => {
  it('useFavoriteChannel PUTs /channels/:id/favorite with the favorite flag', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useFavoriteChannel as never, {
      channelID: 'ch-1',
      favorite: true,
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/favorite');
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({ favorite: true });
  });

  it('useSetCategory PUTs /channels/:id/category and includes sidebarPosition when supplied', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useSetCategory as never, {
      channelID: 'ch-1',
      categoryID: 'c-1',
      sidebarPosition: 5,
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/channels/ch-1/category');
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ categoryID: 'c-1', sidebarPosition: 5 });
  });

  it('useSetCategory omits sidebarPosition when not supplied', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useSetCategory as never, {
      channelID: 'ch-1',
      categoryID: 'c-1',
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ categoryID: 'c-1' });
  });

  it('useFavoriteConversation PUTs /conversations/:id/favorite', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useFavoriteConversation as never, {
      conversationID: 'cv-1',
      favorite: false,
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-1/favorite');
    expect(JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body)).toEqual({ favorite: false });
  });

  it('useSetConversationCategory PUTs /conversations/:id/category', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useSetConversationCategory as never, {
      conversationID: 'cv-1',
      categoryID: 'c-2',
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/conversations/cv-1/category');
  });
});

describe('useSidebar — optimistic cache updates', () => {
  it('useFavoriteChannel optimistically patches the userChannels cache and rolls back on error', async () => {
    apiFetchMock.mockRejectedValue(new Error('boom'));
    const { qc, screen } = await renderMutation(
      useFavoriteChannel as never,
      { channelID: 'ch-1', favorite: true },
      {
        key: queryKeys.userChannels(),
        data: [{ channelID: 'ch-1', favorite: false, categoryID: '', channelName: 'general' }],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    const after = qc.getQueryData<{ favorite: boolean }[]>(queryKeys.userChannels());
    expect(after?.[0].favorite).toBe(false);
  });

  it('useSetCategory optimistically patches the userChannels cache before the server replies', async () => {
    let resolveFn: (() => void) | null = null;
    apiFetchMock.mockImplementation(
      () => new Promise<void>((resolve) => { resolveFn = () => resolve(); }),
    );
    const { qc, screen } = await renderMutation(
      useSetCategory as never,
      { channelID: 'ch-1', categoryID: 'c-1' },
      {
        key: queryKeys.userChannels(),
        data: [{ channelID: 'ch-1', categoryID: '', channelName: 'general' }],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    const mid = qc.getQueryData<{ categoryID: string }[]>(queryKeys.userChannels());
    expect(mid?.[0].categoryID).toBe('c-1');
    resolveFn?.();
  });

  it('useSetConversationCategory optimistically patches the categoryID and a non-matching row is left intact', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { qc, screen } = await renderMutation(
      useSetConversationCategory as never,
      { conversationID: 'cv-1', categoryID: 'c-9' },
      {
        key: queryKeys.userConversations(),
        data: [
          { conversationID: 'cv-1', categoryID: '', displayName: 'Bob' },
          { conversationID: 'cv-other', categoryID: '', displayName: 'Carol' },
        ],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    const rows = qc.getQueryData<{ conversationID: string; categoryID: string }[]>(queryKeys.userConversations());
    // The targeted row is patched (sidebarAttrRowID conversation branch),
    // the non-matching row is returned untouched.
    expect(rows?.find((r) => r.conversationID === 'cv-1')?.categoryID).toBe('c-9');
    expect(rows?.find((r) => r.conversationID === 'cv-other')?.categoryID).toBe('');
  });

  it('useSetConversationCategory includes sidebarPosition when supplied', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const { screen } = await renderMutation(useSetConversationCategory as never, {
      conversationID: 'cv-1',
      categoryID: 'c-2',
      sidebarPosition: 7,
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    const body = JSON.parse((apiFetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({ categoryID: 'c-2', sidebarPosition: 7 });
  });
});

describe('useSidebar — DnD debug-instrumented category mutations', () => {
  it('useUpdateCategory with debug disabled skips the debug log and still PATCHes', async () => {
    // Debug OFF (default beforeEach) — sidebarDndDebug returns early
    // before logging (the disabled branch of sidebarDndDebugEnabled).
    apiFetchMock.mockResolvedValue({ id: 'c-1', name: 'renamed', position: 1 });
    const { screen } = await renderMutation(
      useUpdateCategory as never,
      { id: 'c-1', name: 'renamed' },
      { key: queryKeys.sidebarCategories(), data: [{ id: 'c-1', name: 'old', position: 1 }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/sidebar/categories/c-1');
  });

  it('useUpdateCategory with debug enabled optimistically patches position only and leaves other categories intact', async () => {
    try { localStorage.setItem('ex.sidebarDndDebug', '1'); } catch { /* noop */ }
    apiFetchMock.mockResolvedValue({ id: 'c-1', name: 'old', position: 2500 });
    const { qc, screen } = await renderMutation(
      // Only position supplied → name-undefined ternary arm, position-defined arm.
      useUpdateCategory as never,
      { id: 'c-1', position: 2500 },
      {
        key: queryKeys.sidebarCategories(),
        data: [
          { id: 'c-1', name: 'old', position: 1000 },
          { id: 'c-2', name: 'other', position: 2000 },
        ],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    const cats = qc.getQueryData<{ id: string; name: string; position: number }[]>(queryKeys.sidebarCategories());
    expect(cats?.find((c) => c.id === 'c-1')?.position).toBe(2500);
    expect(cats?.find((c) => c.id === 'c-1')?.name).toBe('old');
    // Non-matching category passes through the category.id !== vars.id arm unchanged.
    expect(cats?.find((c) => c.id === 'c-2')?.position).toBe(2000);
    try { localStorage.removeItem('ex.sidebarDndDebug'); } catch { /* noop */ }
  });

  it('useUpdateCategory with debug enabled rolls back and formats an Error message on failure', async () => {
    try { localStorage.setItem('ex.sidebarDndDebug', '1'); } catch { /* noop */ }
    apiFetchMock.mockRejectedValue(new Error('patch failed'));
    const { qc, screen } = await renderMutation(
      useUpdateCategory as never,
      { id: 'c-1', name: 'renamed' },
      { key: queryKeys.sidebarCategories(), data: [{ id: 'c-1', name: 'old', position: 1000 }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    // Rolled back to the previous name after the rejection (onError path,
    // which formats the Error via sidebarDndDebugError → error.message).
    const cats = qc.getQueryData<{ id: string; name: string }[]>(queryKeys.sidebarCategories());
    expect(cats?.[0].name).toBe('old');
    try { localStorage.removeItem('ex.sidebarDndDebug'); } catch { /* noop */ }
  });

  it('useReorderCategories with debug enabled rolls back and formats a non-Error rejection on failure', async () => {
    try { localStorage.setItem('ex.sidebarDndDebug', '1'); } catch { /* noop */ }
    // Reject with a plain string → sidebarDndDebugError takes the String(error) arm.
    apiFetchMock.mockRejectedValue('reorder boom');
    const { qc, screen } = await renderMutation(
      useReorderCategories as never,
      { categories: [{ id: 'c-1', name: 'a', position: 1000 }, { id: 'c-2', name: 'b', position: 2000 }], movedID: 'c-1', afterID: '' },
      {
        key: queryKeys.sidebarCategories(),
        data: [{ id: 'c-1', name: 'a', position: 1000 }, { id: 'c-2', name: 'b', position: 2000 }],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    const cats = qc.getQueryData<{ id: string }[]>(queryKeys.sidebarCategories());
    expect(cats?.map((c) => c.id)).toEqual(['c-1', 'c-2']);
    try { localStorage.removeItem('ex.sidebarDndDebug'); } catch { /* noop */ }
  });
});

describe('useSidebar — useReorderSidebar (batch drop persistence)', () => {
  // Seeds BOTH list caches independently (renderMutation takes one), so the
  // channel/conversation optimistic patches and each rollback arm are driven.
  const reorderMove = {
    itemType: 'channel' as const,
    itemID: 'ch-1',
    section: 'favorites' as const,
    afterType: '' as const,
    afterID: '',
  };

  async function renderReorder(
    vars: { move: typeof reorderMove; updates: SidebarReorderUpdate[] },
    seeds: { channels?: unknown[]; conversations?: unknown[] },
  ) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (seeds.channels) qc.setQueryData(queryKeys.userChannels(), seeds.channels);
    if (seeds.conversations) qc.setQueryData(queryKeys.userConversations(), seeds.conversations);
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MutationTrigger hook={useReorderSidebar as never} vars={vars} />
      </QueryClientProvider>,
    );
    return { qc, screen };
  }

  it('sends ONE move event, paints both caches optimistically, and applies the server truth', async () => {
    // The server answers with the rows it actually wrote — including the
    // attributes it decided (favorite flip) and a renumbered neighbor.
    apiFetchMock.mockResolvedValue({
      updates: [
        { itemType: 'channel', itemID: 'ch-1', position: 1024, favorite: true, categoryID: 'work' },
        { itemType: 'conversation', itemID: 'cv-1', position: 2048 },
      ],
    });
    const { qc, screen } = await renderReorder(
      {
        move: { ...reorderMove, section: 'category' as const, categoryID: 'work' },
        updates: [
          { id: 'ch-1', kind: 'channel', categoryID: 'work', favorite: true, sidebarPosition: 1000 },
          { id: 'cv-1', kind: 'conversation', categoryID: '', favorite: false, sidebarPosition: 2000 },
        ],
      },
      {
        channels: [
          { channelID: 'ch-1', categoryID: '', favorite: false, sidebarPosition: 0, channelName: 'general' },
          { channelID: 'ch-2', categoryID: '', favorite: false, sidebarPosition: 0, channelName: 'random' }, // untouched → !upd branch
        ],
        conversations: [{ conversationID: 'cv-1', categoryID: '', favorite: false, sidebarPosition: 0, displayName: 'Bob' }],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));

    // ONE event-shaped request; the old per-row category/favorite endpoints
    // are never called for a drop.
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/sidebar/move');

    const chans = qc.getQueryData<{ channelID: string; sidebarPosition: number; favorite: boolean }[]>(queryKeys.userChannels());
    // ch-1 carries the SERVER-committed position (1024) and flag, not the
    // optimistic preview's 1000.
    expect(chans?.find((c) => c.channelID === 'ch-1')).toMatchObject({ sidebarPosition: 1024, favorite: true, categoryID: 'work' });
    expect(chans?.find((c) => c.channelID === 'ch-2')).toMatchObject({ sidebarPosition: 0 }); // untouched
    const convs = qc.getQueryData<{ conversationID: string; sidebarPosition: number }[]>(queryKeys.userConversations());
    expect(convs?.find((c) => c.conversationID === 'cv-1')?.sidebarPosition).toBe(2048);
  });

  it('optimistic patch is a no-op on an unseeded cache (rows undefined → early return)', async () => {
    apiFetchMock.mockResolvedValue({ updates: [] });
    // Only the conversations cache is seeded — the channels cache is undefined,
    // so applyReorderOptimistic hits `if (!rows) return rows`.
    const { qc, screen } = await renderReorder(
      {
        move: { ...reorderMove, itemType: 'conversation' as const, itemID: 'cv-1' },
        updates: [{ id: 'cv-1', kind: 'conversation', categoryID: 'c-2', favorite: false, sidebarPosition: 3000 }],
      },
      { conversations: [{ conversationID: 'cv-1', categoryID: '', favorite: false, sidebarPosition: 0, displayName: 'Bob' }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(qc.getQueryData(queryKeys.userChannels())).toBeUndefined();
    const convs = qc.getQueryData<{ conversationID: string; categoryID: string }[]>(queryKeys.userConversations());
    expect(convs?.[0].categoryID).toBe('c-2');
  });

  it('rolls back the channels cache on error and skips the absent conversations cache', async () => {
    apiFetchMock.mockRejectedValue(new Error('write failed'));
    // Channels seeded (previousChannels truthy → rolled back), conversations
    // unseeded (previousConversations falsy → skip arm).
    const { qc, screen } = await renderReorder(
      {
        move: reorderMove,
        updates: [{ id: 'ch-1', kind: 'channel', categoryID: 'work', favorite: true, sidebarPosition: 1000 }],
      },
      { channels: [{ channelID: 'ch-1', categoryID: '', favorite: false, sidebarPosition: 500, channelName: 'general' }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    const chans = qc.getQueryData<{ channelID: string; sidebarPosition: number; favorite: boolean }[]>(queryKeys.userChannels());
    expect(chans?.[0]).toMatchObject({ sidebarPosition: 500, favorite: false }); // rolled back
    expect(qc.getQueryData(queryKeys.userConversations())).toBeUndefined();
  });

  it('a 409 layout conflict on an item move rolls back and marks both lists stale', async () => {
    const { ApiError: RealApiError } = await import('@/lib/api');
    apiFetchMock.mockRejectedValue(new RealApiError(409, 'sidebar: layout changed since it was read', {
      error: { code: 'sidebar_conflict', message: 'sidebar: layout changed since it was read' },
    }));
    const { qc, screen } = await renderReorder(
      {
        move: reorderMove,
        updates: [{ id: 'ch-1', kind: 'channel', categoryID: '', favorite: true, sidebarPosition: 1000 }],
      },
      {
        channels: [{ channelID: 'ch-1', categoryID: '', favorite: false, sidebarPosition: 500, channelName: 'general' }],
        conversations: [{ conversationID: 'cv-1', categoryID: '', favorite: false, sidebarPosition: 100, displayName: 'Bob' }],
      },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(qc.getQueryState(queryKeys.userChannels())?.isInvalidated).toBe(true);
    });
    expect(qc.getQueryState(queryKeys.userConversations())?.isInvalidated).toBe(true);
    // Rolled back to the pre-drop order.
    const chans = qc.getQueryData<{ channelID: string; sidebarPosition: number }[]>(queryKeys.userChannels());
    expect(chans?.[0].sidebarPosition).toBe(500);
  });

  it('a non-409 ApiError does not invalidate (plain rollback, no conflict handling)', async () => {
    const { ApiError: RealApiError } = await import('@/lib/api');
    apiFetchMock.mockRejectedValue(new RealApiError(500, 'boom'));
    const { qc, screen } = await renderReorder(
      {
        move: reorderMove,
        updates: [{ id: 'ch-1', kind: 'channel', categoryID: '', favorite: true, sidebarPosition: 1000 }],
      },
      { channels: [{ channelID: 'ch-1', categoryID: '', favorite: false, sidebarPosition: 500, channelName: 'general' }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    expect(qc.getQueryState(queryKeys.userChannels())?.isInvalidated).toBe(false);
  });

  it('rolls back the conversations cache on error and skips the absent channels cache', async () => {
    apiFetchMock.mockRejectedValue(new Error('write failed'));
    // Conversations seeded (previousConversations truthy → rolled back),
    // channels unseeded (previousChannels falsy → skip arm).
    const { qc, screen } = await renderReorder(
      {
        move: { ...reorderMove, itemType: 'conversation' as const, itemID: 'cv-1' },
        updates: [{ id: 'cv-1', kind: 'conversation', categoryID: 'c-2', favorite: false, sidebarPosition: 2000 }],
      },
      { conversations: [{ conversationID: 'cv-1', categoryID: '', favorite: false, sidebarPosition: 700, displayName: 'Bob' }] },
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 250));
    const convs = qc.getQueryData<{ conversationID: string; sidebarPosition: number }[]>(queryKeys.userConversations());
    expect(convs?.[0].sidebarPosition).toBe(700); // rolled back
    expect(qc.getQueryData(queryKeys.userChannels())).toBeUndefined();
  });
});
