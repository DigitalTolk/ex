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
import { MemberPicker } from '@/components/usergroups/MemberPicker';
import { canBeGroupMember } from '@/lib/user-groups';
import { MAX_USER_GROUP_MEMBERS } from '@/lib/limits';
import type { User } from '@/types';

const ONCALL = {
  id: 'group-oncall', handle: 'oncall', name: 'On-call engineers', description: 'Pages', disabled: false,
  memberCount: 2, createdBy: 'u-me', createdAt: '', updatedAt: '', memberIds: ['u-ann', 'u-gone'],
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
    if (key === 'GET /api/v1/usergroups') return Promise.resolve(groups.filter((g) => !g.disabled));
    if (key === 'GET /api/v1/usergroups?includeDisabled=true') return Promise.resolve(groups);
    if (path.startsWith('/api/v1/usergroup-handles/')) return Promise.resolve({ available: !path.endsWith('/oncall') });
    const m = /^GET \/api\/v1\/usergroups\/([^/]+)$/.exec(key);
    if (m) return m[1] in detail ? Promise.resolve(detail[m[1]]) : Promise.reject(new Error('not found'));
    if (key === 'POST /api/v1/usergroups') return Promise.resolve({ ...ONCALL, id: 'group-new', ...JSON.parse(init!.body!) });
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

  it('says so when there are no groups yet, and hides Create from those who may not manage', async () => {
    groups = [];
    canManage = false;
    renderAt('/directory/groups');
    expect(await screen.findByText('No user groups yet.')).toBeInTheDocument();
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

describe('creating a user group', () => {
  it('suggests the handle, checks it, picks members and opens the new group', async () => {
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Design Crew' } });
    expect(screen.getByLabelText('Handle')).toHaveValue('design-crew');
    expect(await screen.findByText('@design-crew is available.')).toBeInTheDocument();

    // Only active members can be picked: no guests, bots or deactivated people.
    expect(screen.queryByLabelText('Guest')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bot')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Gone')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Ann'));
    fireEvent.click(screen.getByLabelText('Bob'));
    fireEvent.click(screen.getByLabelText('Bob'));
    expect(screen.getByTestId('member-count')).toHaveTextContent(`1 / ${MAX_USER_GROUP_MEMBERS}`);

    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/v1/usergroups')[0][1].body)).toEqual({
      handle: 'design-crew', name: 'Design Crew', description: '', memberIds: ['u-ann'],
    });
    await waitFor(() => expect(where()).toBe('/directory/groups?group=group-new'));
  });

  it('refuses a taken or malformed handle, and shows a failed save', async () => {
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'On call' } });
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: '@OnCall' } });
    expect(await screen.findByText('@oncall is taken.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: '-x' } });
    expect(await screen.findByText(/2 to 30 lowercase letters/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'pager' } });
    await screen.findByText('@pager is available.');
    fail['POST /api/v1/usergroups'] = new Error('that handle is taken');
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('that handle is taken');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
  });

  it('closes from its close button', async () => {
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
  });

  it('says nothing about a handle whose check failed', async () => {
    fail['GET /api/v1/usergroup-handles/pager'] = new Error('offline');
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pager' } });
    await waitFor(() => expect(calls('GET /api/v1/usergroup-handles/pager')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/is available|is taken|Checking/)).not.toBeInTheDocument());
  });

  it('ignores the answer for a handle that was changed while it was being checked', async () => {
    let answerSlow: (v: unknown) => void = () => {};
    const routed = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation((path: string, init?: Init) =>
      path === '/api/v1/usergroup-handles/slow' ? new Promise((r) => { answerSlow = r; }) : routed(path, init),
    );
    renderAt('/directory/groups');
    fireEvent.click(await screen.findByRole('button', { name: 'Create user group' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Slow' } });
    expect(await screen.findByText('Checking…')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'quick' } });
    expect(await screen.findByText('@quick is available.')).toBeInTheDocument();
    answerSlow({ available: false });
    await waitFor(() => expect(screen.getByText('@quick is available.')).toBeInTheDocument());
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
  });

  it('lets a manager remove and add members', async () => {
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ann' }));
    await waitFor(() => expect(calls('DELETE /api/v1/usergroups/group-oncall/members/u-ann')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Add members' }));
    const add = screen.getByRole('button', { name: /^Add/ });
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Bob'));
    fireEvent.click(screen.getByRole('button', { name: 'Add (1)' }));
    await waitFor(() => expect(calls('POST /api/v1/usergroups/group-oncall/members')).toHaveLength(1));
    expect(JSON.parse(calls('POST /api/v1/usergroups/group-oncall/members')[0][1].body)).toEqual({ userIds: ['u-bob'] });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add members' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add members' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Add members' })).toBeInTheDocument();
  });

  it('shows a failed member change', async () => {
    fail['DELETE /api/v1/usergroups/group-oncall/members/u-ann'] = new Error('only admins manage user groups');
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Ann' }));
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

  it('edits the details, warning that old mentions show the new handle', async () => {
    renderAt('/directory/groups?group=group-oncall');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    expect(screen.getByLabelText('Handle')).toHaveValue('oncall');
    fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'pager' } });
    expect(screen.getByText('Messages that already mention @oncall will show @pager.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: ' New ' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls('PATCH /api/v1/usergroups/group-oncall')).toHaveLength(1));
    expect(JSON.parse(calls('PATCH /api/v1/usergroups/group-oncall')[0][1].body)).toEqual({
      handle: 'pager', name: 'On-call engineers', description: 'New',
    });
    // Back on the group.
    expect(await screen.findByTestId('usergroup-detail')).toBeInTheDocument();
  });

  it('is read-only for those who may not manage groups', async () => {
    canManage = false;
    renderAt('/directory/groups?group=group-oncall');
    await screen.findByTestId('usergroup-detail');
    expect(screen.queryByRole('button', { name: 'Remove Ann' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
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
  it('shows members by id and offers no one to pick', async () => {
    roster.data = undefined;
    renderAt('/directory/groups?group=group-oncall');
    const panel = await screen.findByTestId('usergroup-detail');
    expect(within(panel).getByText('u-ann')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add members' }));
    expect(screen.getByText('No one matches.')).toBeInTheDocument();
  });
});

describe('MemberPicker', () => {
  it('stops at the member cap and says so', () => {
    const full = Array.from({ length: MAX_USER_GROUP_MEMBERS }, (_, i) => `x-${i}`);
    render(<MemberPicker selected={full} onChange={vi.fn()} />);
    expect(screen.getByLabelText('Ann')).toBeDisabled();
    expect(screen.getByText(`A user group holds at most ${MAX_USER_GROUP_MEMBERS} people.`)).toBeInTheDocument();
  });

  it('says when nobody matches the search', () => {
    render(<MemberPicker selected={[]} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search people to add'), { target: { value: 'zzz' } });
    expect(screen.getByText('No one matches.')).toBeInTheDocument();
  });

  it('knows who can be a member', () => {
    expect(USERS.map((u) => canBeGroupMember(u as unknown as User))).toEqual([true, true, false, false, false]);
  });
});
