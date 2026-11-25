import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

type Init = { method?: string; body?: string };

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

let mockRole: 'admin' | 'member' | 'guest' = 'admin';
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', displayName: 'Me', systemRole: mockRole, status: 'active' }, isAuthenticated: true }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(), isOnline: () => false, setUserOnline: vi.fn() }),
}));
vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: [], isLoading: false }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

const USERS = vi.hoisted(() => [
  { id: 'u-ann', displayName: 'Ann', email: 'ann@example.com', systemRole: 'member', status: 'active', avatarURL: '/ann.png' },
  { id: 'u-bob', displayName: 'Bob', email: 'bob@example.com', systemRole: 'member', status: 'active' },
  { id: 'u-gone', displayName: 'Gone', email: 'gone@example.com', systemRole: 'member', status: 'deactivated' },
  { id: 'u-guest', displayName: 'Guest', email: 'g@example.com', systemRole: 'guest', status: 'active' },
  { id: 'u-bot', displayName: 'Bot', email: 'b@example.com', systemRole: 'member', status: 'active', isBot: true },
]);
// The roster, or undefined while it loads.
const roster = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useAllUsers: () => ({ data: roster.data }),
}));

// A stand-in for the confirm dialog: rendered while open.
vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: { open: boolean; title: string; confirmLabel: string; onOpenChange: (o: boolean) => void; onConfirm: () => void }) =>
    props.open ? (
      <div role="dialog" aria-label={props.title}>
        <button onClick={props.onConfirm}>{props.confirmLabel}</button>
        <button onClick={() => props.onOpenChange(false)}>Keep it</button>
      </div>
    ) : null,
}));

import DirectoriesPage from '@/pages/DirectoriesPage';

const ONCALL = {
  id: 'group-oncall', handle: 'oncall', name: 'On-call engineers', description: 'Pages', disabled: false,
  memberCount: 2, createdBy: '', createdAt: '', updatedAt: '', memberIds: ['u-ann', 'u-gone'],
  source: { kind: 'entra-group', id: 'g-oncall', key: 'entra-group:g-oncall' },
};
const OFF = { ...ONCALL, id: 'group-off', handle: 'off', name: 'Old team', description: '', disabled: true, memberCount: 0, memberIds: [] };
// One member nobody has a profile for.
const SOLO = { ...ONCALL, id: 'group-solo', handle: 'solo', name: 'Solo', description: '', memberCount: 1, memberIds: ['u-unknown'] };

let canManage = true;
let groups = [ONCALL, OFF, SOLO];
let detail: Record<string, unknown> = { 'group-oncall': ONCALL, 'group-off': OFF, 'group-solo': SOLO };
let fail: Record<string, Error> = {};

function routeApi() {
  mockApiFetch.mockImplementation((path: string, init?: Init) => {
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (fail[key]) return Promise.reject(fail[key]);
    if (key === 'GET /api/v1/usergroup-permissions') return Promise.resolve({ canManage });
    if (key === 'GET /api/v1/usergroup-sync') return Promise.resolve({ configured: true, intervalMinutes: 30, running: false, skipped: [] });
    if (key === 'GET /api/v1/usergroups') return Promise.resolve(groups.filter((g) => !g.disabled));
    if (key === 'GET /api/v1/usergroups?includeDisabled=true') return Promise.resolve(groups);
    const m = /^GET \/api\/v1\/usergroups\/([^/]+)$/.exec(key);
    if (m) return m[1] in detail ? Promise.resolve(detail[m[1]]) : Promise.reject(new Error('not found'));
    return Promise.resolve(ONCALL);
  });
}

function calls(key: string) {
  return mockApiFetch.mock.calls.filter(([p, i]) => `${(i as Init | undefined)?.method ?? 'GET'} ${p}` === key);
}

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}
const where = () => screen.getByTestId('where').textContent;

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/directory/:section" element={<><DirectoriesPage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
  mockRole = 'admin';
  canManage = true;
  groups = [ONCALL, OFF, SOLO];
  detail = { 'group-oncall': ONCALL, 'group-off': OFF, 'group-solo': SOLO };
  fail = {};
  roster.data = USERS;
  routeApi();
});

describe('Directory › Groups', () => {
  it('lists enabled groups with their member counts, and disabled ones on request', async () => {
    renderAt('/directory/groups');
    expect(screen.getByRole('tab', { name: 'Groups' })).toHaveAttribute('aria-selected', 'true');
    const list = await screen.findByRole('list', { name: 'User groups' });
    expect(within(list).getByText('@oncall')).toBeInTheDocument();
    expect(within(list).getByText('2 members')).toBeInTheDocument();
    expect(within(list).getByText('1 member')).toBeInTheDocument();
    expect(within(list).queryByText('@off')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText('@off')).toBeInTheDocument();
    expect(screen.getByText('0 members')).toBeInTheDocument();
    expect(screen.getAllByText('Disabled')).toHaveLength(1);
  });

  it('filters by handle or name, and says when nothing matches', async () => {
    renderAt('/directory/groups');
    await screen.findByText('@oncall');
    fireEvent.change(screen.getByLabelText('Search user groups'), { target: { value: 'engineers' } });
    expect(screen.getByText('@oncall')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search user groups'), { target: { value: 'zzz' } });
    expect(screen.getByText('No user groups match.')).toBeInTheDocument();
  });

  it('says so when there are no groups yet, and offers no way to create one, even to admins', async () => {
    groups = [];
    renderAt('/directory/groups');
    expect(await screen.findByText("No user groups yet. They come from Microsoft 365.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create user group' })).not.toBeInTheDocument();
  });

  it('switches to the Groups tab from the tab bar', async () => {
    renderAt('/directory/channels');
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }));
    await waitFor(() => expect(where()).toBe('/directory/groups'));
  });

  it('has no Groups tab for guests', () => {
    mockRole = 'guest';
    renderAt('/directory/groups');
    expect(screen.queryByRole('tab', { name: 'Groups' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('a user group', () => {
  it('opens from the list and shows its members, inactive ones greyed out', async () => {
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByText('@oncall'));
    const panel = await screen.findByTestId('usergroup-detail');
    expect(within(panel).getByText('On-call engineers')).toBeInTheDocument();
    expect(within(panel).getByText('Pages')).toBeInTheDocument();
    expect(within(panel).getByText('2 members')).toBeInTheDocument();
    expect(within(panel).getByText('Gone')).toHaveClass('opacity-50');
    expect(where()).toBe('/directory/groups?group=group-oncall');
    // Members come from Microsoft 365: even an admin can't edit them here.
    expect(screen.queryByRole('button', { name: 'Remove Ann' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add members' })).not.toBeInTheDocument();
  });

  it('shows a failed change', async () => {
    fail['POST /api/v1/usergroups/group-off/enable'] = new Error('only admins manage user groups');
    renderAt('/directory/groups?group=group-off');
    fireEvent.click(await screen.findByRole('button', { name: 'Enable group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('only admins manage user groups');
  });

  it('disables after a confirmation, and enables again', async () => {
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Disable group' }));
    // The confirm sits beside the open group dialog, which may hide it from
    // the accessibility tree: reach its buttons regardless.
    fireEvent.click(screen.getByRole('button', { name: 'Keep it', hidden: true }));
    expect(calls('POST /api/v1/usergroups/group-oncall/disable')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Disable group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable', hidden: true }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-oncall/disable')).toHaveLength(1));
  });

  it('enables a disabled group', async () => {
    renderAt('/directory/groups?group=group-off');
    expect(await screen.findByText('No members yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enable group' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-off/enable')).toHaveLength(1));
  });

  it('is read-only for those who may not manage groups', async () => {
    canManage = false;
    renderAt('/directory/groups?group=group-oncall');
    await screen.findByTestId('usergroup-detail');
    for (const name of ['Disable group', 'Enable group', 'Edit details']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('names a member it has no profile for by id, and counts one member', async () => {
    renderAt('/directory/groups?group=group-solo');
    const panel = await screen.findByTestId('usergroup-detail');
    expect(within(panel).getByText('1 member')).toBeInTheDocument();
    expect(within(panel).getByText('u-unknown')).toBeInTheDocument();
  });

  it('says when the group is gone, and closes', async () => {
    renderAt('/directory/groups?group=group-nope');
    expect(await screen.findByText('This group no longer exists.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(where()).toBe('/directory/groups'));
  });
});

describe('while the roster loads', () => {
  it('shows members by id', async () => {
    roster.data = undefined;
    renderAt('/directory/groups?group=group-oncall');
    const panel = await screen.findByTestId('usergroup-detail');
    expect(within(panel).getByText('u-ann')).toBeInTheDocument();
  });
});
