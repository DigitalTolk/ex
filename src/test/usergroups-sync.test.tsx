import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type Init = { method?: string; body?: string };

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-admin', displayName: 'Admin', systemRole: 'admin', status: 'active' }, isAuthenticated: true }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(), isOnline: () => false, setUserOnline: vi.fn() }),
}));
vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: [], isLoading: false }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useAllUsers: () => ({
    data: [
      { id: 'u-ann', displayName: 'Ann', email: 'ann@example.com', systemRole: 'member', status: 'active' },
      { id: 'u-bob', displayName: 'Bob', email: 'bob@example.com', systemRole: 'member', status: 'active' },
    ],
  }),
}));

import DirectoriesPage from '@/pages/DirectoriesPage';
import { ApiError } from '@/lib/api';

const DOPE = {
  id: 'group-dope', handle: 'eng-dope', name: 'eng-dope', description: 'DOPE squad (Engineering)', disabled: false, memberCount: 2,
  createdBy: '', createdAt: '', updatedAt: '', memberIds: ['u-ann', 'u-bob'], syncSkipped: 3,
  source: { kind: 'entra-group', id: 'g-dope', key: 'entra-group:g-dope' },
};
const ENG = {
  ...DOPE, id: 'group-eng', handle: 'eng', name: 'eng', description: 'Engineering department', syncSkipped: 1,
  source: { kind: 'entra-group', id: 'g-eng', key: 'entra-group:g-eng' },
};
const SYNCED = {
  configured: true, intervalMinutes: 30, running: false,
  lastSyncedAt: new Date(Date.now() - 10 * 60_000).toISOString(), finishedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  skipped: [] as unknown[],
};

let canManage = true;
let detail: Record<string, unknown> = {};
let status: unknown = SYNCED;
let syncNow: () => Promise<unknown> = () => Promise.resolve({ ...SYNCED, running: true, trigger: 'manual' });

function routeApi() {
  mockApiFetch.mockImplementation((path: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (key === 'GET /api/v1/usergroup-permissions') return Promise.resolve({ canManage });
    if (key === 'GET /api/v1/usergroup-sync') return Promise.resolve(status);
    if (key === 'POST /api/v1/usergroup-sync') return syncNow();
    if (key === 'GET /api/v1/usergroups') return Promise.resolve([DOPE, ENG]);
    const m = /^GET \/api\/v1\/usergroups\/([^/]+)$/.exec(key);
    if (m) return Promise.resolve(detail[m[1]]);
    return Promise.resolve(DOPE);
  });
}

function calls(key: string) {
  return mockApiFetch.mock.calls.filter(([p, i]) => `${(i as Init | undefined)?.method ?? 'GET'} ${p}` === key);
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/directory/:section" element={<DirectoriesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  canManage = true;
  detail = { 'group-dope': DOPE, 'group-eng': ENG };
  status = SYNCED;
  syncNow = () => Promise.resolve({ ...SYNCED, running: true, trigger: 'manual' });
  routeApi();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a group's source", () => {
  it('says its members come from Microsoft 365, and who of them is not in ex, with no edit controls', async () => {
    renderAt('/directory/groups?group=group-dope');
    const source = await screen.findByTestId('usergroup-source');
    expect(source).toHaveTextContent('Members come from its Microsoft 365 group.');
    expect(source).toHaveTextContent("3 people in the Microsoft 365 group aren't in ex, or can't be in a group.");
    expect(screen.getByRole('button', { name: 'Disable group' })).toBeInTheDocument();
    for (const name of ['Edit details', 'Add members', 'Change Microsoft 365 group']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('counts one person not in ex', async () => {
    renderAt('/directory/groups?group=group-eng');
    expect(await screen.findByTestId('usergroup-source')).toHaveTextContent("1 person in the Microsoft 365 group isn't in ex");
  });
});

describe('what an admin should know about a group', () => {
  it('says a group gone from Microsoft 365 is empty and can be disabled', async () => {
    detail['group-dope'] = { ...DOPE, memberIds: [], memberCount: 0, syncState: 'source-missing' };
    renderAt('/directory/groups?group=group-dope');
    expect(await screen.findByRole('status')).toHaveTextContent('This group is no longer in Microsoft 365, so it has no members. You can disable it.');
  });

  it('says a rename that clashes keeps the old handle', async () => {
    detail['group-dope'] = { ...DOPE, name: 'product', syncState: 'handle-conflict' };
    renderAt('/directory/groups?group=group-dope');
    expect(await screen.findByRole('status')).toHaveTextContent(
      "It was renamed to product in Microsoft 365, but that can't be its handle here, so it stays @eng-dope until the name is changed there.",
    );
  });
});

describe('the sync report', () => {
  it('tells admins how often and when groups last synced', async () => {
    renderAt('/directory/groups');
    const report = await screen.findByTestId('usergroup-sync-report');
    await waitFor(() => expect(report).toHaveTextContent('Groups sync from Microsoft 365 every 30 minutes. Last sync 10 minutes ago.'));
    expect(within(report).getByRole('button', { name: 'Sync now' })).toBeEnabled();
    expect(within(report).queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    [60, 'every hour'],
    [120, 'every 2 hours'],
    [1, 'every minute'],
    [90, 'every 90 minutes'],
  ])('reads an interval of %i minutes as "%s"', async (intervalMinutes, text) => {
    status = { ...SYNCED, intervalMinutes };
    renderAt('/directory/groups');
    expect(await screen.findByTestId('usergroup-sync-report')).toHaveTextContent(text);
  });

  it('says when nothing has synced yet, why the last sync failed, and which groups it could not use', async () => {
    status = {
      ...SYNCED, lastSyncedAt: undefined, lastError: 'the parent group lists no groups',
      skipped: [
        { name: 'Product AI!', reason: 'not a valid handle' },
        { groupId: 'group-dope', name: 'product', reason: '@product is taken by another group' },
      ],
    };
    renderAt('/directory/groups');
    const report = await screen.findByTestId('usergroup-sync-report');
    expect(report).toHaveTextContent('Not synced yet.');
    expect(within(report).getByRole('alert')).toHaveTextContent('Last sync failed: the parent group lists no groups');
    fireEvent.click(within(report).getByText("2 Microsoft 365 groups couldn't be used as they are"));
    const list = within(report).getByRole('list', { name: 'Microsoft 365 groups not used' });
    expect(list).toHaveTextContent('Product AI! · not a valid handle');
    expect(list).toHaveTextContent('product · @product is taken by another group');
  });

  it('counts one group it could not use', async () => {
    status = { ...SYNCED, skipped: [{ name: 'x', reason: 'not a valid handle' }] };
    renderAt('/directory/groups');
    expect(await screen.findByTestId('usergroup-sync-report')).toHaveTextContent("1 Microsoft 365 group couldn't be used as they are");
  });

  it('says when user groups are not connected', async () => {
    status = { configured: false, intervalMinutes: 0, running: false, skipped: [] };
    renderAt('/directory/groups');
    expect(await screen.findByTestId('usergroup-sync-report')).toHaveTextContent("User groups aren't connected to Microsoft 365.");
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows nothing until the status arrives', async () => {
    status = new Promise(() => {});
    renderAt('/directory/groups');
    await screen.findByText('@eng-dope');
    expect(screen.queryByTestId('usergroup-sync-report')).not.toBeInTheDocument();
  });

  it('is not shown to members', async () => {
    canManage = false;
    renderAt('/directory/groups');
    await screen.findByText('@eng-dope');
    expect(screen.queryByTestId('usergroup-sync-report')).not.toBeInTheDocument();
    expect(calls('GET /api/v1/usergroup-sync')).toHaveLength(0);
  });
});

describe('Sync now', () => {
  it('starts a sync and shows it running until it ends', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/directory/groups');
    const report = await screen.findByTestId('usergroup-sync-report');
    fireEvent.click(await within(report).findByRole('button', { name: 'Sync now' }));
    expect(await within(report).findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    expect(calls('POST /api/v1/usergroup-sync')).toHaveLength(1);

    // The sync ends: the next status poll (every 3 s while running) shows
    // it, and the cooldown.
    status = { ...SYNCED, lastSyncedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(await within(report).findByRole('button', { name: 'Synced just now' })).toBeDisabled();
  });

  it('is disabled while a sync runs anywhere', async () => {
    status = { ...SYNCED, running: true };
    renderAt('/directory/groups');
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
  });

  it('comes back after the cooldown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    status = { ...SYNCED, finishedAt: new Date().toISOString() };
    renderAt('/directory/groups');
    expect(await screen.findByRole('button', { name: 'Synced just now' })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('shows the cooldown the server answers with', async () => {
    syncNow = () => Promise.reject(new ApiError(429, 'a sync just finished', { ...SYNCED, finishedAt: new Date().toISOString() }));
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByRole('button', { name: 'Synced just now' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows why a sync could not start', async () => {
    syncNow = () => Promise.reject(new ApiError(409, "user groups aren't connected to Microsoft 365"));
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("user groups aren't connected to Microsoft 365");
  });
});
