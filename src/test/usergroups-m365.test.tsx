import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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

const LINKED = {
  id: 'group-oncall', handle: 'oncall', name: 'On-call', description: '', disabled: false, memberCount: 2,
  createdBy: 'u-admin', createdAt: '', updatedAt: '', memberIds: ['u-ann', 'u-bob'],
  entraGroupId: 'entra-oncall', entraGroupName: 'On-call engineers', syncedAt: new Date().toISOString(), syncSkipped: 1,
};
const MANUAL = { ...LINKED, id: 'group-sre', handle: 'sre', name: 'SRE', entraGroupId: undefined, entraGroupName: undefined, syncedAt: undefined, syncSkipped: 0 };
const ENTRA = [
  { id: 'entra-oncall', displayName: 'On-call engineers', mail: 'oncall@example.com', kind: 'security' },
  { id: 'entra-big', displayName: 'Everyone', kind: 'dynamic' },
  { id: 'entra-other', displayName: 'Other', kind: 'odd' },
];

let canLink = true;
let detail: Record<string, unknown> = {};
let fail: Record<string, Error> = {};

function routeApi() {
  mockApiFetch.mockImplementation((path: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (fail[key]) return Promise.reject(fail[key]);
    if (key === 'GET /api/v1/usergroup-permissions') return Promise.resolve({ canManage: true, canLinkMicrosoft: canLink });
    if (key === 'GET /api/v1/usergroups') return Promise.resolve([LINKED, MANUAL]);
    if (path.startsWith('/api/v1/usergroup-handles/')) return Promise.resolve({ available: true });
    if (path.startsWith('/api/v1/usergroup-sources/microsoft?q=')) {
      return Promise.resolve(path.endsWith('q=nothing') ? [] : ENTRA);
    }
    if (path.startsWith('/api/v1/usergroup-sources/microsoft/entra-big/preview')) return Promise.resolve({ overLimit: true });
    if (path.startsWith('/api/v1/usergroup-sources/microsoft/')) {
      return Promise.resolve(path.includes('groupId=')
        ? { users: 3, toAdd: 1, toRemove: 1, skipped: 1, overLimit: false }
        : { users: 2, toAdd: 2, toRemove: 0, skipped: 0, overLimit: false });
    }
    const m = /^GET \/api\/v1\/usergroups\/([^/]+)$/.exec(key);
    if (m) return Promise.resolve(detail[m[1]]);
    if (key === 'POST /api/v1/usergroups') return Promise.resolve({ ...LINKED, id: 'group-new' });
    return Promise.resolve(LINKED);
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
  canLink = true;
  detail = { 'group-oncall': LINKED, 'group-sre': MANUAL, 'group-new': { ...LINKED, id: 'group-new' } };
  fail = {};
  routeApi();
});

async function pickEntra(name: string, query = 'on') {
  fireEvent.change(screen.getByLabelText('Search Microsoft 365 groups'), { target: { value: query } });
  fireEvent.click(await screen.findByLabelText(name));
}

describe('creating a group from Microsoft 365', () => {
  it('picks the Microsoft 365 group, names the group after it and creates it linked', async () => {
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.click(screen.getByLabelText('A Microsoft 365 group'));
    expect(screen.queryByTestId('member-count')).not.toBeInTheDocument();
    await pickEntra('On-call engineers');
    expect(screen.getByText('oncall@example.com')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByText('Dynamic')).toBeInTheDocument();
    expect(screen.getByText('odd')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('On-call engineers');
    expect(await screen.findByTestId('link-summary')).toHaveTextContent('Adds 2');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create group' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/v1/usergroups')[0][1].body)).toEqual({
      handle: 'on-call-engineers', name: 'On-call engineers', description: '', memberIds: [], entraGroupId: 'entra-oncall',
    });
  });

  it("won't create from a group over the cap, keeps a typed name, and says when nothing matches", async () => {
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'All hands' } });
    fireEvent.click(screen.getByLabelText('A Microsoft 365 group'));
    await pickEntra('Everyone');
    expect(await screen.findByTestId('link-summary')).toHaveTextContent('more than 1000 people');
    expect(screen.getByLabelText('Name')).toHaveValue('All hands');
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Search Microsoft 365 groups'), { target: { value: 'nothing' } });
    expect(await screen.findByText('No groups match.')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Added manually in ex'));
    expect(screen.getByTestId('member-count')).toBeInTheDocument();
  });

  it('only offers manual groups when linking is unavailable', async () => {
    canLink = false;
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    expect(screen.queryByLabelText('A Microsoft 365 group')).not.toBeInTheDocument();
  });
});

describe('a group linked to Microsoft 365', () => {
  it('is badged in the list and read-only in its detail', async () => {
    renderAt('/directory/groups');
    const row = (await screen.findByText('@oncall')).closest('button')!;
    expect(within(row).getByText('Microsoft 365')).toBeInTheDocument();

    fireEvent.click(row);
    const linked = await screen.findByTestId('usergroup-linked');
    expect(linked).toHaveTextContent('Managed in Microsoft 365 · On-call engineers');
    expect(linked).toHaveTextContent('Last synced');
    expect(linked).toHaveTextContent("1 person in the Microsoft 365 group isn't in ex yet.");
    expect(screen.queryByRole('button', { name: 'Remove Ann' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add members' })).not.toBeInTheDocument();
  });

  it('syncs now and unlinks', async () => {
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-oncall/sync')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/v1/usergroups/group-oncall/sync')[0][1].body)).toEqual({ applyRemovals: false });
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-oncall/unlink')).toHaveLength(1));
  });

  it('shows a held sync and applies it', async () => {
    detail['group-oncall'] = { ...LINKED, syncState: 'held-removal', pendingRemoval: 7, syncSkipped: 3 };
    renderAt('/directory/groups?group=group-oncall');
    expect(await screen.findByText('Sync needs review: 7 people would be removed.')).toBeInTheDocument();
    expect(screen.getByTestId('usergroup-linked')).toHaveTextContent("3 people in the Microsoft 365 group aren't in ex yet.");
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-oncall/sync')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/v1/usergroups/group-oncall/sync')[0][1].body)).toEqual({ applyRemovals: true });
  });

  it('explains every other sync state', async () => {
    for (const [state, text] of [
      ['paused-oversize', 'more than 1000 people'],
      ['source-missing', "can't be found"],
      ['error', "couldn't be reached"],
    ]) {
      detail['group-oncall'] = { ...LINKED, syncState: state, pendingRemoval: 1, syncedAt: undefined };
      const { unmount } = renderAt('/directory/groups?group=group-oncall');
      expect(await screen.findByRole('status')).toHaveTextContent(text);
      unmount();
    }
  });

  it('a held removal of one person, seen by an admin who may not link', async () => {
    canLink = false;
    detail['group-oncall'] = { ...LINKED, syncState: 'held-removal', pendingRemoval: 1 };
    renderAt('/directory/groups?group=group-oncall');
    expect(await screen.findByText('Sync needs review: 1 person would be removed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('shows the sync in progress', async () => {
    let finish: (v: unknown) => void = () => {};
    const route = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: Init) =>
      init?.method === 'POST' && path.endsWith('/sync') ? new Promise((r) => { finish = r; }) : route(path, init));
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByRole('button', { name: 'Syncing…' })).toBeDisabled();
    await act(async () => finish(LINKED));
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeEnabled();
  });

  it('shows a failed sync', async () => {
    fail['POST /api/v1/usergroups/group-oncall/sync'] = new Error('this group is already being synced');
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already being synced');
  });
});

describe('linking an existing group', () => {
  it('previews the change and links', async () => {
    renderAt('/directory/groups?group=group-sre');
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Microsoft 365 group' }));
    expect(screen.getByRole('button', { name: 'Link group' })).toBeDisabled();
    await pickEntra('On-call engineers');
    expect(await screen.findByTestId('link-summary')).toHaveTextContent("Adds 1 · removes 1 · 1 aren't in ex yet");
    fireEvent.click(screen.getByRole('button', { name: 'Link group' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-sre/link')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/v1/usergroups/group-sre/link')[0][1].body)).toEqual({ entraGroupId: 'entra-oncall' });
    expect(await screen.findByTestId('usergroup-detail')).toBeInTheDocument();
  });

  it('shows the link in progress', async () => {
    let finish: (v: unknown) => void = () => {};
    const route = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: Init) =>
      init?.method === 'POST' && path.endsWith('/link') ? new Promise((r) => { finish = r; }) : route(path, init));
    renderAt('/directory/groups?group=group-sre');
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Microsoft 365 group' }));
    await pickEntra('On-call engineers');
    await screen.findByTestId('link-summary');
    fireEvent.click(screen.getByRole('button', { name: 'Link group' }));
    expect(await screen.findByRole('button', { name: 'Linking…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => finish(LINKED));
    expect(await screen.findByTestId('usergroup-detail')).toBeInTheDocument();
  });

  it('shows a failed link, and cancels', async () => {
    fail['POST /api/v1/usergroups/group-sre/link'] = new Error('that Microsoft 365 group is already linked to another user group');
    renderAt('/directory/groups?group=group-sre');
    fireEvent.click(await screen.findByRole('button', { name: 'Link to Microsoft 365 group' }));
    await pickEntra('On-call engineers');
    await screen.findByTestId('link-summary');
    fireEvent.click(screen.getByRole('button', { name: 'Link group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already linked');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('usergroup-detail')).toBeInTheDocument();
  });

  it('is not offered when linking is unavailable', async () => {
    canLink = false;
    renderAt('/directory/groups?group=group-sre');
    await screen.findByTestId('usergroup-detail');
    expect(screen.queryByRole('button', { name: 'Link to Microsoft 365 group' })).not.toBeInTheDocument();
  });
});
