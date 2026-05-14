import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { SearchAdminPanel } from './SearchAdminPanel';

const statusState = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  error: null as unknown,
}));
const reindexMutate = vi.hoisted(() => vi.fn());
const reindexState = vi.hoisted(() => ({
  mutate: reindexMutate,
  isPending: false,
  isError: false,
  error: null as unknown,
}));

vi.mock('@/hooks/useSearchAdmin', () => ({
  useSearchAdminStatus: () => statusState,
  useStartSearchReindex: () => reindexState,
}));

describe('SearchAdminPanel browser behaviour', () => {
  it('renders a loading placeholder while the status query is pending', async () => {
    statusState.isLoading = true;
    statusState.isError = false;
    statusState.data = undefined;
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText('Loading…')).toBeVisible();
  });

  it('renders an alert message when the status query errors out', async () => {
    statusState.isLoading = false;
    statusState.isError = true;
    statusState.error = new Error('cluster down');
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText('cluster down')).toBeVisible();
  });

  it('shows the not-configured copy when configured=false', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = { configured: false };
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText(/isn't configured/)).toBeVisible();
  });

  it('renders the cluster, indices, and reindex cards when configured=true', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      cluster: { status: 'green', number_of_nodes: 3, active_shards: 6 },
      indices: [{ name: 'messages', health: 'green', docs: 100, storeSize: '5mb' }],
      reindex: { running: false, startedAt: 0, completedAt: 0 },
    };
    await render(<SearchAdminPanel />);
    expect(document.querySelector('[data-testid="admin-search-panel"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="cluster-status"]')?.textContent).toBe('green');
    expect(document.querySelector('[data-testid="reindex-status"]')?.textContent).toBe('idle');
  });

  it('disables the rebuild button while a reindex is running', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      reindex: { running: true, users: 1, channels: 1, messages: 5, files: 0, startedAt: 1700000000, completedAt: 0 },
    };
    await render(<SearchAdminPanel />);
    const btn = document.querySelector('[data-testid="reindex-start"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/Reindexing/);
  });

  it('clicking the rebuild button triggers the start mutation', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      reindex: { running: false, startedAt: 0, completedAt: 0 },
    };
    reindexMutate.mockReset();
    await render(<SearchAdminPanel />);
    const btn = document.querySelector('[data-testid="reindex-start"]') as HTMLButtonElement;
    btn.click();
    expect(reindexMutate).toHaveBeenCalled();
  });

  it('surfaces the reindex error message when the mutation fails', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      reindex: { running: false, startedAt: 0, completedAt: 0 },
    };
    reindexState.isError = true;
    reindexState.error = new Error('start failed');
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText('start failed')).toBeVisible();
    reindexState.isError = false;
    reindexState.error = null;
  });

  it('renders cluster and indices error blocks when present', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      cluster: { status: 'red' },
      clusterError: 'cluster red',
      indices: [],
      indicesError: 'no indices',
      reindex: { running: false, startedAt: 0, completedAt: 0 },
    };
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText('cluster red')).toBeVisible();
    await expect.element(screen.getByText('no indices')).toBeVisible();
  });
});
