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
} from './useSidebar';
import { queryKeys } from '@/lib/query-keys';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
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

  it('useReorderCategories PATCHes once per category with multiplied positions', async () => {
    apiFetchMock.mockResolvedValue({});
    const { screen } = await renderMutation(useReorderCategories as never, {
      categories: [
        { id: 'c-1', name: 'a', position: 999 },
        { id: 'c-2', name: 'b', position: 999 },
      ],
    });
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const bodies = apiFetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
    expect(bodies[0].position).toBe(1000);
    expect(bodies[1].position).toBe(2000);
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
});
