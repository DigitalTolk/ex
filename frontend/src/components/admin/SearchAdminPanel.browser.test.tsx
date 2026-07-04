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
const rebuildMappingMutate = vi.hoisted(() => vi.fn());
const rebuildMappingState = vi.hoisted(() => ({
  mutate: rebuildMappingMutate,
  isPending: false,
  isError: false,
  error: null as unknown,
}));

vi.mock('@/hooks/useSearchAdmin', () => ({
  useSearchAdminStatus: () => statusState,
  useStartSearchReindex: () => reindexState,
  useStartSearchMappingRebuild: () => rebuildMappingState,
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

  it('shows a default error message when the status error is not an Error instance', async () => {
    statusState.isLoading = false;
    statusState.isError = true;
    statusState.error = 'a string, not an Error';
    statusState.data = undefined;
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText('Could not load search status')).toBeVisible();
  });

  it('renders the reindex card idle when the reindex object is absent (running ?? false)', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      cluster: { status: 'green', number_of_nodes: 1, active_shards: 1 },
      // An index with no storeSize → the `|| '—'` fallback.
      indices: [{ name: 'messages', health: 'green', docs: 0, storeSize: '' }],
      reindex: undefined,
    };
    await render(<SearchAdminPanel />);
    expect(document.querySelector('[data-testid="reindex-status"]')?.textContent).toBe('idle');
    expect(document.querySelector('[data-testid="admin-search-panel"]')?.textContent).toContain('—');
  });

  it('shows the "Starting…" label while the start mutation is pending', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      cluster: { status: 'green', number_of_nodes: 1, active_shards: 1 },
      indices: [{ name: 'messages', health: 'green', docs: 1, storeSize: '1mb' }],
      reindex: { running: false, startedAt: 0, completedAt: 0 },
    };
    reindexState.isPending = true;
    try {
      await render(<SearchAdminPanel />);
      const btn = document.querySelector('[data-testid="reindex-start"]') as HTMLButtonElement;
      // not running + isPending → the `start.isPending ? 'Starting…'` arm.
      expect(btn.textContent).toMatch(/Starting/);
      expect(btn.disabled).toBe(true);
    } finally {
      reindexState.isPending = false;
    }
  });

  it('shows a default reindex-error message when the start error is not an Error', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      cluster: { status: 'green', number_of_nodes: 1, active_shards: 1 },
      indices: [{ name: 'messages', health: 'green', docs: 1, storeSize: '1mb' }],
      reindex: { running: false, startedAt: 0, completedAt: 0 },
    };
    reindexState.isError = true;
    reindexState.error = 'a string, not an Error';
    try {
      const screen = await render(<SearchAdminPanel />);
      await expect.element(screen.getByText('Could not start reindex')).toBeVisible();
    } finally {
      reindexState.isError = false;
      reindexState.error = null;
    }
  });

  it('surfaces a prior reindex lastError and a start-mutation error', async () => {
    reindexState.isError = true;
    reindexState.error = new Error('reindex kickoff failed');
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = {
      configured: true,
      cluster: { status: 'yellow', number_of_nodes: 1, active_shards: 1 },
      indices: [{ name: 'messages', health: 'yellow', docs: 1, storeSize: '1mb' }],
      reindex: { running: false, startedAt: 0, completedAt: 0, lastError: 'last run died' },
    };
    try {
      const screen = await render(<SearchAdminPanel />);
      await expect.element(screen.getByText('last run died')).toBeVisible();
      await expect.element(screen.getByText('reindex kickoff failed')).toBeVisible();
    } finally {
      reindexState.isError = false;
      reindexState.error = null;
    }
  });

  // -------- users/channels mapping rebuild card --------

  const configured = (extra: Record<string, unknown> = {}) => ({
    configured: true,
    cluster: { status: 'green', number_of_nodes: 1, active_shards: 1 },
    indices: [],
    reindex: { running: false, startedAt: 0, completedAt: 0 },
    ...extra,
  });

  it('renders the mapping-rebuild card idle by default', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured();
    await render(<SearchAdminPanel />);
    const btn = document.querySelector('[data-testid="mapping-rebuild-start"]') as HTMLButtonElement;
    expect(document.querySelector('[data-testid="mapping-rebuild-status"]')?.textContent).toBe('idle');
    expect(btn.textContent).toMatch(/Rebuild users & channels/);
    expect(btn.disabled).toBe(false);
  });

  it('disables the mapping-rebuild button and shows "Rebuilding…" while it runs', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured({
      mappingRebuild: { running: true, users: 2, channels: 1, startedAt: 1700000000, completedAt: 0 },
    });
    await render(<SearchAdminPanel />);
    const btn = document.querySelector('[data-testid="mapping-rebuild-start"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/Rebuilding/);
    expect(document.querySelector('[data-testid="mapping-rebuild-status"]')?.textContent).toBe('running');
    // users/channels present → the "Last run rebuilt…" line renders.
    expect(document.querySelector('[data-testid="mapping-rebuild-card"]')?.textContent).toContain('2 users');
  });

  it('shows "Starting…" while the mapping-rebuild mutation is pending', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured();
    rebuildMappingState.isPending = true;
    try {
      await render(<SearchAdminPanel />);
      const btn = document.querySelector('[data-testid="mapping-rebuild-start"]') as HTMLButtonElement;
      expect(btn.textContent).toMatch(/Starting/);
      expect(btn.disabled).toBe(true);
    } finally {
      rebuildMappingState.isPending = false;
    }
  });

  it('clicking the mapping-rebuild button triggers its start mutation', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured();
    rebuildMappingMutate.mockReset();
    await render(<SearchAdminPanel />);
    const btn = document.querySelector('[data-testid="mapping-rebuild-start"]') as HTMLButtonElement;
    btn.click();
    expect(rebuildMappingMutate).toHaveBeenCalled();
  });

  it('surfaces the mapping-rebuild mutation error (Error instance)', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured();
    rebuildMappingState.isError = true;
    rebuildMappingState.error = new Error('a mapping rebuild is already running');
    try {
      const screen = await render(<SearchAdminPanel />);
      await expect.element(screen.getByText('a mapping rebuild is already running')).toBeVisible();
    } finally {
      rebuildMappingState.isError = false;
      rebuildMappingState.error = null;
    }
  });

  it('shows a default mapping-rebuild error when the error is not an Error', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured();
    rebuildMappingState.isError = true;
    rebuildMappingState.error = 'a string, not an Error';
    try {
      const screen = await render(<SearchAdminPanel />);
      await expect.element(screen.getByText('Could not start mapping rebuild')).toBeVisible();
    } finally {
      rebuildMappingState.isError = false;
      rebuildMappingState.error = null;
    }
  });

  it('surfaces a mapping-rebuild lastError and a mappingRebuildError from the status', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured({
      mappingRebuild: { running: false, users: 0, channels: 0, startedAt: 0, completedAt: 0, lastError: 'alias swap failed' },
      mappingRebuildError: 'redis get failed',
    });
    const screen = await render(<SearchAdminPanel />);
    await expect.element(screen.getByText('alias swap failed')).toBeVisible();
    await expect.element(screen.getByText('redis get failed')).toBeVisible();
  });

  it('renders the live vs expected schema version, flagging stale indices', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured({
      schemaVersions: [
        { index: 'ex_users', current: 2, expected: 2, stale: false },
        { index: 'ex_channels', current: null, expected: 2, stale: true },
      ],
    });
    await render(<SearchAdminPanel />);
    const list = document.querySelector('[data-testid="schema-versions"]');
    expect(list).not.toBeNull();
    expect(list?.textContent).toContain('v2 / v2');
    expect(list?.textContent).toContain('up to date');
    // Unstamped index → dash for current and a "rebuilding" flag.
    expect(list?.textContent).toContain('v— / v2');
    expect(document.querySelector('[data-testid="schema-stale-ex_channels"]')).not.toBeNull();
  });

  it('omits the schema-version list when the status carries none', async () => {
    statusState.isLoading = false;
    statusState.isError = false;
    statusState.data = configured({});
    await render(<SearchAdminPanel />);
    expect(document.querySelector('[data-testid="schema-versions"]')).toBeNull();
  });
});
