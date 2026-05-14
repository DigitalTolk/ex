import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUnfurl } from './useUnfurl';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

function Probe({ url }: { url: string | null }) {
  const r = useUnfurl(url);
  return (
    <div
      data-testid="probe"
      data-status={r.status}
      data-data={r.data === null ? 'null' : r.data ? JSON.stringify(r.data) : ''}
    />
  );
}

function renderProbe(url: string | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Probe url={url} />
    </QueryClientProvider>,
  );
}

describe('useUnfurl', () => {
  it('is disabled when url is null and does not fetch', async () => {
    await renderProbe(null);
    await new Promise((r) => setTimeout(r, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('encodes the url and calls /api/v1/unfurl', async () => {
    apiFetchMock.mockResolvedValue({ url: 'https://x.io', title: 'X' });
    await renderProbe('https://x.io/path?q=1');
    await new Promise((r) => setTimeout(r, 200));
    expect(apiFetchMock).toHaveBeenCalled();
    expect(apiFetchMock.mock.calls[0][0]).toContain('/api/v1/unfurl?url=https%3A%2F%2Fx.io%2Fpath');
  });

  it('treats apiFetch returning undefined as a null preview', async () => {
    apiFetchMock.mockResolvedValue(undefined);
    const screen = await renderProbe('https://x.io');
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('null');
  });

  it('treats any thrown error from apiFetch as a null preview (no error state)', async () => {
    apiFetchMock.mockRejectedValue(new Error('network'));
    const screen = await renderProbe('https://x.io');
    await new Promise((r) => setTimeout(r, 200));
    // queryFn catches and returns null, so the query is in "success" with data=null.
    expect(screen.getByTestId('probe').element().getAttribute('data-status')).toBe('success');
    expect(screen.getByTestId('probe').element().getAttribute('data-data')).toBe('null');
  });
});
