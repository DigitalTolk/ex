import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type Init = { method?: string; body?: string };

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
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

const DOPE = {
  id: 'group-dope', handle: 'dope', name: 'DOPE', description: 'Squad DOPE in Engineering', disabled: false, memberCount: 2,
  createdBy: '', createdAt: '', updatedAt: '', memberIds: ['u-ann', 'u-bob'], syncSkipped: 3,
  source: { kind: 'squad', squad: 'DOPE', department: 'Engineering', key: 'squad:dope' },
};
const ENG = {
  ...DOPE, id: 'group-eng', handle: 'engineering', name: 'Engineering', description: 'Department Engineering', syncSkipped: 1,
  source: { kind: 'department', department: 'Engineering', key: 'dept:engineering' },
};
const SYNCED = {
  lastSyncedAt: new Date().toISOString(), readable: 40,
  anomalies: {
    people: 3, counts: { 'non-standard-dash': 2, odd: 1 },
    examples: [
      { value: 'Engineering – DOPE', kinds: ['non-standard-dash', 'spacing'], people: 2 },
      { value: '', kinds: ['odd'], people: 1 },
    ],
  },
};

let canManage = true;
let detail: Record<string, unknown> = {};
let status: unknown = SYNCED;

function routeApi() {
  mockApiFetch.mockImplementation((path: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (key === 'GET /api/v1/usergroup-permissions') return Promise.resolve({ canManage });
    if (key === 'GET /api/v1/usergroup-sync') return Promise.resolve(status);
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
  routeApi();
});

describe("a group's source", () => {
  it('shows the squad it follows and who is not in ex yet, with no Microsoft 365 controls', async () => {
    renderAt('/directory/groups?group=group-dope');
    const source = await screen.findByTestId('usergroup-source');
    expect(source).toHaveTextContent('Squad DOPE in Engineering');
    expect(source).toHaveTextContent("3 people in this squad aren't in ex yet.");
    for (const name of ['Sync now', 'Change Microsoft 365 group', 'Unlink', 'Add members']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the department a department group follows', async () => {
    renderAt('/directory/groups?group=group-eng');
    const source = await screen.findByTestId('usergroup-source');
    expect(source).toHaveTextContent('Department Engineering');
    expect(source).toHaveTextContent("1 person in this department isn't in ex yet.");
  });
});

describe('a department or squad that is gone', () => {
  it('tells admins the group is empty and can be disabled', async () => {
    detail['group-dope'] = { ...DOPE, memberIds: [], memberCount: 0, syncState: 'source-missing' };
    renderAt('/directory/groups?group=group-dope');
    expect(await screen.findByRole('status')).toHaveTextContent('No one in Microsoft 365 is in this squad any more. You can disable the group.');
    expect(screen.getByRole('button', { name: 'Disable group' })).toBeInTheDocument();
  });

  it('names a gone department', async () => {
    detail['group-eng'] = { ...ENG, memberIds: [], memberCount: 0, syncState: 'source-missing' };
    renderAt('/directory/groups?group=group-eng');
    expect(await screen.findByRole('status')).toHaveTextContent('No one in Microsoft 365 is in this department any more.');
  });
});

describe('the sync report', () => {
  it('tells admins when groups last synced and which department values were read only partly', async () => {
    renderAt('/directory/groups');
    const report = await screen.findByTestId('usergroup-sync-report');
    await waitFor(() => expect(report).toHaveTextContent('Last sync'));
    expect(report).toHaveTextContent('sync every 30 minutes');
    fireEvent.click(within(report).getByText("3 people have a department ex couldn't fully read"));
    const list = within(report).getByRole('list', { name: 'Department values read only partly' });
    expect(list).toHaveTextContent('Engineering – DOPE · a dash other than "-", a missing space · 2 people');
    expect(list).toHaveTextContent('(empty) · odd · 1 person');
  });

  it('says when nothing has synced yet, and when a sync was paused', async () => {
    status = { readable: 0, held: true, anomalies: { people: 1, counts: {}, examples: [] } };
    renderAt('/directory/groups');
    const report = await screen.findByTestId('usergroup-sync-report');
    await waitFor(() => expect(report).toHaveTextContent('Not synced yet.'));
    expect(within(report).getByRole('status')).toHaveTextContent('so this sync was paused');
    expect(report).toHaveTextContent("1 person has a department ex couldn't fully read");
  });

  it('shows nothing until the status arrives, and nothing to members', async () => {
    status = new Promise(() => {});
    renderAt('/directory/groups');
    await screen.findByText('@dope');
    expect(screen.queryByTestId('usergroup-sync-report')).not.toBeInTheDocument();
  });

  it('is not shown to members', async () => {
    canManage = false;
    renderAt('/directory/groups');
    await screen.findByText('@dope');
    expect(screen.queryByTestId('usergroup-sync-report')).not.toBeInTheDocument();
    expect(calls('GET /api/v1/usergroup-sync')).toHaveLength(0);
  });
});
