import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useSearchUsers,
  useSearchChannels,
  useSearchMessages,
  useSearchFiles,
  type SearchResult,
} from './useSearch';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe({
  hook,
}: {
  hook: () => { data?: SearchResult; isLoading: boolean; status: string };
}) {
  const r = hook();
  return (
    <div
      data-testid="probe"
      data-loading={r.isLoading ? 'true' : 'false'}
      data-status={r.status}
      data-total={r.data?.total ?? ''}
      data-url={apiFetchMock.mock.calls[0]?.[0] ?? ''}
    />
  );
}

function renderProbe(hook: () => ReturnType<typeof useSearchMessages>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe hook={hook} />
    </QueryClientProvider>,
  );
}

describe('useSearch', () => {
  it('useSearchUsers does NOT fire when the query is shorter than 2 chars', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() => useSearchUsers('a', true));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useSearchUsers fires when enabled and query length >= 2', async () => {
    apiFetchMock.mockResolvedValue({ total: 1, hits: [{ id: 'u-1', score: 1, _source: {} }] });
    await renderProbe(() => useSearchUsers('al', true));
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalled();
    const call = apiFetchMock.mock.calls[0][0] as string;
    expect(call).toContain('/api/v1/search/users');
    expect(call).toContain('q=al');
    expect(call).toContain('limit=5');
  });

  it('useSearchChannels uses the channels index with the default limit', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() => useSearchChannels('gen', true));
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock.mock.calls[0][0]).toMatch(/\/search\/channels\?/);
  });

  it('useSearchMessages includes from / in / sort options when supplied', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() =>
      useSearchMessages('hello', true, 8, { from: 'u-1', in: 'ch-1', sort: 'newest' }),
    );
    await new Promise((r) => setTimeout(r, 200));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('from=u-1');
    expect(url).toContain('in=ch-1');
    expect(url).toContain('sort=newest');
  });

  it('useSearchMessages still fires with an empty q when filter-only', async () => {
    apiFetchMock.mockResolvedValue({ total: 5, hits: [] });
    await renderProbe(() => useSearchMessages('', true, 8, { from: 'u-1' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalled();
  });

  it('useSearchMessages does not fire when q is short and no filter is set', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() => useSearchMessages('a', true));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('useSearchFiles maps to /search/files with the supplied limit', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() => useSearchFiles('doc', true, 12));
    await new Promise((r) => setTimeout(r, 200));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/search/files?');
    expect(url).toContain('limit=12');
  });

  it('useSearchFiles forwards from / in / sort options', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() => useSearchFiles('doc', true, 8, { from: 'u-2', in: 'ch-2', sort: 'oldest' }));
    await new Promise((r) => setTimeout(r, 200));
    const url = apiFetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/search/files?');
    expect(url).toContain('from=u-2');
    expect(url).toContain('in=ch-2');
    expect(url).toContain('sort=oldest');
  });

  it('disabled hook does not fetch even when q is long enough', async () => {
    apiFetchMock.mockResolvedValue({ total: 0, hits: [] });
    await renderProbe(() => useSearchUsers('alice', false));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
