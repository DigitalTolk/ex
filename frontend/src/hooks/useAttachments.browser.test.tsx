import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useAttachment,
  useAttachmentsBatch,
  useDeleteDraftAttachment,
} from './useAttachments';
import { queryKeys } from '@/lib/query-keys';

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

function MutationTrigger({ hook, vars }: { hook: () => { mutate: (v: unknown) => void }; vars: unknown }) {
  const m = hook();
  return <button data-testid="trigger" onClick={() => m.mutate(vars)} />;
}

describe('useAttachment', () => {
  it('is disabled when id is missing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachment(undefined)} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('fetches /attachments/:id without context query when ctx is omitted', async () => {
    apiFetchMock.mockResolvedValue({ id: 'a-1' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachment('a-1')} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/attachments/a-1');
  });

  it('appends a context query when parentID / parentType / messageID are supplied', async () => {
    apiFetchMock.mockResolvedValue({ id: 'a-1' });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe
          hook={() =>
            useAttachment('a-1', {
              parentID: 'ch-1',
              parentType: 'channel',
              messageID: 'm-1',
            })
          }
        />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('parentID=ch-1');
    expect(url).toContain('parentType=channel');
    expect(url).toContain('messageID=m-1');
  });
});

describe('useAttachmentsBatch', () => {
  it('is disabled when the id list is empty', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={qc}>
        <Probe hook={() => useAttachmentsBatch([])} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('uses a stable sorted cache key and hydrates per-id caches', async () => {
    apiFetchMock.mockResolvedValue([
      { id: 'a-1', filename: 'one' },
      { id: 'a-2', filename: 'two' },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function H() {
      const r = useAttachmentsBatch(['a-2', 'a-1']);
      return <span data-testid="probe" data-map={[...r.map.keys()].join(',')} />;
    }
    const screen = await render(
      <QueryClientProvider client={qc}>
        <H />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect((apiFetchMock.mock.calls[0][0] as string)).toContain('ids=a-1%2Ca-2');
    expect(screen.getByTestId('probe').element().getAttribute('data-map')).toBe('a-1,a-2');
    // Per-id cache hydration:
    expect(qc.getQueryData(queryKeys.attachment('a-1'))).toEqual({ id: 'a-1', filename: 'one' });
    expect(qc.getQueryData(queryKeys.attachment('a-2'))).toEqual({ id: 'a-2', filename: 'two' });
  });
});

describe('useDeleteDraftAttachment', () => {
  it('DELETEs the attachment by id', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={qc}>
        <MutationTrigger hook={useDeleteDraftAttachment as never} vars="a-1" />
      </QueryClientProvider>,
    );
    (screen.getByTestId('trigger').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/v1/attachments/a-1');
    expect((apiFetchMock.mock.calls[0][1] as { method: string }).method).toBe('DELETE');
  });
});
