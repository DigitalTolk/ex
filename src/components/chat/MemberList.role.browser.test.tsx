import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemberList } from './MemberList';
import { useChannelMembers } from '@/hooks/useChannels';
import { apiFetch } from '@/lib/api';
import { ChannelRole } from '@/lib/roles';
import type { ChannelMembership } from '@/types';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

// Changing a member's channel role from the member list: the menu offers what
// the server allows, the PATCH goes out, and the list shows the new badge.

const ROLE_NUMBER = { owner: ChannelRole.Owner, admin: ChannelRole.Admin, member: ChannelRole.Member } as const;

// The server's member list, which a PATCH changes.
let server: Record<string, number>;
let patchError: unknown;

function serve() {
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/channels/ch-1/members' && !init) {
      return Object.entries(server).map(([userID, role]) => ({
        channelID: 'ch-1',
        userID,
        role,
        displayName: { me: 'Me', ann: 'Ann', bob: 'Bob' }[userID],
        joinedAt: '2026-01-01T00:00:00Z',
      })) as ChannelMembership[];
    }
    const m = /^\/api\/v1\/channels\/ch-1\/members\/(\w+)$/.exec(url);
    if (m && init?.method === 'PATCH') {
      if (patchError) throw patchError;
      const { role } = JSON.parse(String(init.body)) as { role: keyof typeof ROLE_NUMBER };
      server[m[1]!] = ROLE_NUMBER[role];
      return undefined;
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  });
}

function Members({ systemRole }: { systemRole?: string }) {
  const { data } = useChannelMembers('ch-1');
  if (!data) return null;
  return (
    <MemberList
      members={data}
      channelId="ch-1"
      currentUserId="me"
      currentUserRole={data.find((m) => m.userID === 'me')?.role as number}
      currentUserSystemRole={systemRole}
    />
  );
}

async function renderMembers(systemRole?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <div style={{ display: 'flex', height: 600 }}>
          <Members systemRole={systemRole} />
        </div>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

// Picks an item from a member's role menu and waits for the menu to close, as
// the next click on the page would.
async function chooseRole(screen: Awaited<ReturnType<typeof renderMembers>>, name: string, item: string) {
  await screen.getByRole('button', { name: `Change role for ${name}` }).click();
  await screen.getByRole('menuitem', { name: item }).click();
  await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();
}

const patches = () =>
  vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH');

beforeEach(() => {
  server = { me: ChannelRole.Member, ann: ChannelRole.Owner, bob: ChannelRole.Member };
  patchError = undefined;
  vi.mocked(apiFetch).mockReset();
  serve();
});

describe('MemberList channel roles', () => {
  it('a system admin who is a plain member hands the channel to a new owner', async () => {
    const screen = await renderMembers('admin');
    await screen.getByRole('button', { name: 'Change role for Bob' }).click();
    await expect.element(screen.getByRole('menuitem', { name: 'Make admin' })).toBeVisible();
    await screen.getByRole('menuitem', { name: 'Make owner' }).click();
    await expect.poll(() => screen.getByText('Owner', { exact: true }).all().length).toBe(2);
    await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();

    // The old owner steps down to member.
    await chooseRole(screen, 'Ann', 'Make member');
    await expect.poll(() => screen.getByText('Owner', { exact: true }).all().length).toBe(1);

    expect(patches().map((c) => [c[0], (c[1] as RequestInit).body])).toEqual([
      ['/api/v1/channels/ch-1/members/bob', JSON.stringify({ role: 'owner' })],
      ['/api/v1/channels/ch-1/members/ann', JSON.stringify({ role: 'member' })],
    ]);
  });

  it('a channel admin moves members to admin but cannot touch the owner', async () => {
    server.me = ChannelRole.Admin;
    const screen = await renderMembers('member');
    await screen.getByRole('button', { name: 'Change role for Bob' }).click();
    await expect.element(screen.getByRole('menuitem', { name: 'Make admin' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Make owner' }).query()).toBeNull();
    await expect.element(screen.getByRole('button', { name: 'Change role for Ann' })).not.toBeInTheDocument();
  });

  it('a plain member gets no role menu', async () => {
    const screen = await renderMembers('member');
    await expect.element(screen.getByText('Bob')).toBeVisible();
    expect(document.querySelector('[aria-label^="Change role for"]')).toBeNull();
  });

  it('says why a refused change failed', async () => {
    patchError = new Error('channel: only owners can promote to owner');
    const screen = await renderMembers('admin');
    await chooseRole(screen, 'Bob', 'Make owner');
    await expect.element(screen.getByRole('alert')).toHaveTextContent('channel: only owners can promote to owner');

    patchError = 'nope';
    await chooseRole(screen, 'Bob', 'Make admin');
    await expect.element(screen.getByRole('alert')).toHaveTextContent('Failed to change role');
  });
});
