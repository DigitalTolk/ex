import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { SearchAdminPanel } from '@/components/admin/SearchAdminPanel';

function wrap(children: ReactNode) {
  // Disable retries so failed fetches surface immediately, and turn
  // the polling interval off — individual tests trigger refetches
  // via apiFetchMock state changes + queryClient invalidations.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(<QueryClientProvider client={qc}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('SearchAdminPanel', () => {
  it('renders an "search not configured" hint when the backend reports configured=false', async () => {
    apiFetchMock.mockResolvedValueOnce({ configured: false });
    wrap(<SearchAdminPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Search isn't configured/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('admin-search-panel')).toBeNull();
  });

  it('renders cluster status, indices, and reindex card when search is configured', async () => {
    apiFetchMock.mockResolvedValueOnce({
      configured: true,
      cluster: { status: 'yellow', number_of_nodes: 1, active_shards: 3 },
      indices: [
        { name: 'ex_users', health: 'yellow', status: 'open', docs: 12, storeSize: '4.6kb' },
        { name: 'ex_channels', health: 'yellow', status: 'open', docs: 5, storeSize: '2kb' },
        { name: 'ex_messages', health: 'missing', status: '', docs: 0, storeSize: '' },
      ],
      reindex: { running: false, users: 0, channels: 0, messages: 0 },
    });
    wrap(<SearchAdminPanel />);
    expect(await screen.findByTestId('admin-search-panel')).toBeInTheDocument();
    expect(screen.getByTestId('cluster-status').textContent).toBe('yellow');
    const table = screen.getByTestId('indices-table');
    expect(table.textContent).toContain('ex_users');
    expect(table.textContent).toContain('12');
    expect(screen.getByTestId('reindex-status').textContent).toBe('idle');
  });

  it('clicking the rebuild button POSTs to /admin/search/reindex and refetches status', async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        configured: true,
        cluster: { status: 'green' },
        indices: [],
        reindex: { running: false, users: 0, channels: 0, messages: 0 },
      })
      // POST start
      .mockResolvedValueOnce({ running: true })
      // status refetch after invalidation
      .mockResolvedValueOnce({
        configured: true,
        cluster: { status: 'green' },
        indices: [],
        reindex: { running: true, users: 0, channels: 0, messages: 0 },
      });

    wrap(<SearchAdminPanel />);
    const btn = await screen.findByTestId('reindex-start');
    fireEvent.click(btn);

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls;
      // Was the POST issued?
      const posted = calls.some(
        (c) =>
          c[0] === '/api/v1/admin/search/reindex' &&
          (c[1] as { method?: string } | undefined)?.method === 'POST',
      );
      expect(posted).toBe(true);
    });

    await waitFor(() =>
      expect(screen.getByTestId('reindex-status').textContent).toBe('running'),
    );
    // While a run is in progress the button is disabled to keep the
    // admin from queueing a second start.
    expect(screen.getByTestId('reindex-start')).toBeDisabled();
  });

  it('surfaces the cluster + indices error fields when the backend can\'t talk to OpenSearch', async () => {
    apiFetchMock.mockResolvedValueOnce({
      configured: true,
      clusterError: 'connection refused',
      indicesError: 'index not found',
      reindex: { running: false, users: 0, channels: 0, messages: 0 },
    });
    wrap(<SearchAdminPanel />);
    await screen.findByTestId('admin-search-panel');
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.getByText('index not found')).toBeInTheDocument();
  });

  it('shows the request error when the status fetch itself fails', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    wrap(<SearchAdminPanel />);
    await waitFor(() =>
      expect(screen.getByText(/network down/)).toBeInTheDocument(),
    );
  });

  const configuredStatus = (extra: Record<string, unknown> = {}) => ({
    configured: true,
    cluster: { status: 'green' },
    indices: [],
    reindex: { running: false, users: 0, channels: 0, messages: 0 },
    ...extra,
  });

  it('renders the mapping-rebuild card idle by default', async () => {
    apiFetchMock.mockResolvedValueOnce(configuredStatus());
    wrap(<SearchAdminPanel />);
    await screen.findByTestId('mapping-rebuild-card');
    expect(screen.getByTestId('mapping-rebuild-status').textContent).toBe('idle');
    expect(screen.getByTestId('mapping-rebuild-start').textContent).toContain(
      'Rebuild users & channels',
    );
    expect(screen.getByTestId('mapping-rebuild-start')).not.toBeDisabled();
  });

  it('clicking rebuild POSTs to /admin/search/rebuild-mapping and flips to running', async () => {
    apiFetchMock
      .mockResolvedValueOnce(configuredStatus())
      .mockResolvedValueOnce({ running: true, users: 0, channels: 0 }); // POST response
    // Fallback for the post-success refetch (and any interval polls): running.
    apiFetchMock.mockResolvedValue(
      configuredStatus({ mappingRebuild: { running: true, users: 0, channels: 0 } }),
    );
    wrap(<SearchAdminPanel />);
    const btn = await screen.findByTestId('mapping-rebuild-start');
    fireEvent.click(btn);

    await waitFor(() => {
      const posted = apiFetchMock.mock.calls.some(
        (c) =>
          c[0] === '/api/v1/admin/search/rebuild-mapping' &&
          (c[1] as { method?: string } | undefined)?.method === 'POST',
      );
      expect(posted).toBe(true);
    });
    await waitFor(() =>
      expect(screen.getByTestId('mapping-rebuild-status').textContent).toBe('running'),
    );
    expect(screen.getByTestId('mapping-rebuild-start')).toBeDisabled();
  });

  it('shows "Starting…" and disables the button while the rebuild request is in flight', async () => {
    let resolvePost: (v: unknown) => void = () => {};
    apiFetchMock
      .mockResolvedValueOnce(configuredStatus())
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolvePost = res as (v: unknown) => void;
          }),
      );
    apiFetchMock.mockResolvedValue(
      configuredStatus({ mappingRebuild: { running: true, users: 0, channels: 0 } }),
    );
    wrap(<SearchAdminPanel />);
    const btn = await screen.findByTestId('mapping-rebuild-start');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(screen.getByTestId('mapping-rebuild-start').textContent).toContain('Starting'),
    );
    expect(screen.getByTestId('mapping-rebuild-start')).toBeDisabled();
    // Settle the mutation so the test ends cleanly (no dangling act()).
    resolvePost({ running: true, users: 0, channels: 0 });
    await waitFor(() =>
      expect(screen.getByTestId('mapping-rebuild-status').textContent).toBe('running'),
    );
  });

  it('shows last-run counts and a mapping-rebuild error from the status', async () => {
    apiFetchMock.mockResolvedValueOnce(
      configuredStatus({
        mappingRebuild: {
          running: false,
          users: 8,
          channels: 3,
          lastError: 'alias swap failed',
          startedAt: 1000,
          completedAt: 2000,
        },
      }),
    );
    wrap(<SearchAdminPanel />);
    await screen.findByTestId('mapping-rebuild-card');
    expect(screen.getByTestId('mapping-rebuild-card').textContent).toContain('8 users');
    expect(screen.getByText('alias swap failed')).toBeInTheDocument();
  });

  it('surfaces a mappingRebuildError from the status payload', async () => {
    apiFetchMock.mockResolvedValueOnce(
      configuredStatus({ mappingRebuildError: 'redis get failed' }),
    );
    wrap(<SearchAdminPanel />);
    await screen.findByTestId('mapping-rebuild-card');
    expect(screen.getByText('redis get failed')).toBeInTheDocument();
  });

  it('surfaces a 409 when another instance already holds the rebuild lock', async () => {
    apiFetchMock
      .mockResolvedValueOnce(configuredStatus())
      .mockRejectedValueOnce(new Error('a mapping rebuild is already running'));
    wrap(<SearchAdminPanel />);
    const btn = await screen.findByTestId('mapping-rebuild-start');
    fireEvent.click(btn);
    await waitFor(() =>
      expect(
        screen.getByText('a mapping rebuild is already running'),
      ).toBeInTheDocument(),
    );
  });
});
