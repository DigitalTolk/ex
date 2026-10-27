import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: (props: { ariaLabel?: string }) => <textarea aria-label={props.ariaLabel ?? 'Message input'} />,
}));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from '@/components/chat/ChannelView';
import { ApiError } from '@/lib/api';
import type { Channel, ChannelMembership } from '@/types';

// Renaming a channel from its header: the name is checked while it is typed,
// the channel's address follows the new name, and a link made under the old
// name still lands on it.

const marketing: Channel = {
  id: 'ch-m',
  name: 'marketing',
  slug: 'marketing',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
};
const general: Channel = { ...marketing, id: 'ch-g', name: 'general', slug: 'general' };
// What the server answers per address: the old name of a renamed channel
// still finds it.
const bySlug: Record<string, Channel> = {
  marketing,
  general,
  'old-mkt': marketing,
  growth: { ...marketing, name: 'growth', slug: 'growth' },
};

let role: ChannelMembership['role'] = 'owner';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' } }),
}));
const unreadValue = {
  unreadChannels: new Set(),
  unreadChannelNotifications: new Set(),
  unreadConversations: new Set(),
  hiddenConversations: new Set(),
  markChannelUnread: vi.fn(),
  markChannelNotificationUnread: vi.fn(),
  markConversationUnread: vi.fn(),
  clearChannelUnread: vi.fn(),
  clearConversationUnread: vi.fn(),
  hideConversation: vi.fn(),
  unhideConversation: vi.fn(),
  setActiveChannel: vi.fn(),
  setActiveConversation: vi.fn(),
  isActiveChannel: vi.fn(() => false),
  isActiveConversation: vi.fn(() => false),
  setActiveThread: vi.fn(),
  isActiveThread: vi.fn(() => false),
};
vi.mock('@/context/UnreadContext', () => ({
  useOptionalUnread: () => undefined,
  useUnread: () => unreadValue,
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false, setUserOnline: vi.fn() }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useChannels')>()),
  useChannelBySlug: (slug: string) => ({ data: bySlug[slug] }),
  useChannelMembers: (id: string) => ({
    data: [{ channelID: id, userID: 'u-1', role, displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' }],
  }),
  useUserChannels: (opts?: { select?: (rows: never[]) => unknown }) => ({ data: opts?.select ? opts.select([]) : [] }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
// The header's dropdown rendered inline, its items as plain buttons.
vi.mock('@/components/ui/dropdown-menu', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/dropdown-menu')>()),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <button className={className}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

// Taken names, as the server's availability check answers them.
const taken = new Set(['sales']);
let patchError: unknown = null;
let privateError: unknown = null;
let checkFails = false;
const mockApiFetch = vi.fn((url: string, init?: { method?: string; body?: string }) => {
  const check = /^\/api\/v1\/channel-names\/([^?]+)\?channel=ch-m$/.exec(url);
  if (check) {
    if (checkFails) return Promise.reject(new Error('offline'));
    return Promise.resolve({ available: !taken.has(decodeURIComponent(check[1]!)) });
  }
  if (url === '/api/v1/channels/ch-m/private' && init?.method === 'POST') {
    if (privateError) return Promise.reject(privateError);
    return Promise.resolve({ ...marketing, type: 'private' });
  }
  if (url === '/api/v1/channels/ch-m' && init?.method === 'PATCH') {
    if (patchError) return Promise.reject(patchError);
    const { name } = JSON.parse(init.body ?? '{}') as { name: string };
    return Promise.resolve({ ...marketing, name, slug: name });
  }
  return Promise.resolve(undefined);
});
const mockToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/toast')>()),
  showToast: (...args: unknown[]) => mockToast(...args),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (url: string, init?: { method?: string; body?: string }) => mockApiFetch(url, init),
}));

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/channel/:id"
            element={
              <>
                <ChannelView />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openRename() {
  fireEvent.click(screen.getByRole('button', { name: /Rename channel/ }));
  return screen.findByRole('textbox', { name: 'Name' });
}

describe('renaming a channel', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    role = 'owner';
    patchError = null;
    checkFails = false;
  });

  it('renames it and moves its address along', async () => {
    const user = userEvent.setup();
    renderAt('/channel/marketing?msg=m1');
    const field = await openRename();
    expect(field).toHaveValue('marketing');
    // Unchanged: nothing to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(field);
    await user.type(field, 'growth');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/channel/growth?msg=m1'));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-m', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'growth' }) }));
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'growth' })).toBeInTheDocument();
  });

  it('says a name is taken while it is typed, before saving', async () => {
    const user = userEvent.setup();
    renderAt('/channel/marketing');
    const field = await openRename();
    await user.clear(field);
    await user.type(field, 'sales');

    expect(await screen.findByText('~sales already exists')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/channels/ch-m', expect.anything());
  });

  it('says a name is taken when someone took it just before saving', async () => {
    const user = userEvent.setup();
    patchError = new ApiError(409, 'a channel with this name already exists');
    renderAt('/channel/marketing');
    const field = await openRename();
    await user.clear(field);
    await user.type(field, 'brand');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channel-names/brand?channel=ch-m', expect.anything()));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('~brand already exists')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/channel/marketing');
  });

  it('shows any other refusal', async () => {
    const user = userEvent.setup();
    patchError = new Error('channel is archived');
    renderAt('/channel/marketing');
    const field = await openRename();
    await user.clear(field);
    await user.type(field, 'brand');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('channel is archived')).toBeInTheDocument();

    patchError = 'not an Error';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Failed to rename channel')).toBeInTheDocument();
  });

  it('reads a failed check as free: the server still decides on save', async () => {
    const user = userEvent.setup();
    checkFails = true;
    renderAt('/channel/marketing');
    const field = await openRename();
    await user.clear(field);
    await user.type(field, 'sales');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channel-names/sales?channel=ch-m', expect.anything()));
    expect(screen.queryByText('~sales already exists')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('closes on Cancel without renaming', async () => {
    renderAt('/channel/marketing');
    await openRename();
    // The footer's Cancel (the phone header carries its own).
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument());
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/channels/ch-m', expect.anything());
  });

  it('is not offered for #general', () => {
    renderAt('/channel/general');
    expect(screen.queryByRole('button', { name: /Rename channel/ })).not.toBeInTheDocument();
  });

  it('is not offered to a plain member', () => {
    role = 'member';
    renderAt('/channel/marketing');
    expect(screen.queryByRole('button', { name: /Rename channel/ })).not.toBeInTheDocument();
  });
});

describe('a link made before a rename', () => {
  it('lands on the channel under its current name', async () => {
    renderAt('/channel/old-mkt?msg=m1');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/channel/marketing?msg=m1'));
    expect(screen.getByRole('heading', { name: 'marketing' })).toBeInTheDocument();
  });

  it('keeps an address by channel ID as it is', async () => {
    bySlug['ch-m'] = marketing;
    try {
      renderAt('/channel/ch-m');
      expect(await screen.findByRole('heading', { name: 'marketing' })).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent('/channel/ch-m');
    } finally {
      delete bySlug['ch-m'];
    }
  });
});

describe('making a public channel private', () => {
  beforeEach(() => {
    mockApiFetch.mockClear();
    mockToast.mockClear();
    role = 'owner';
    privateError = null;
  });

  it('asks first, then makes it private', async () => {
    renderAt('/channel/marketing');
    fireEvent.click(screen.getByRole('button', { name: /Make private/ }));
    expect(await screen.findByText('Make ~marketing private?')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/channels/ch-m/private', expect.anything());

    fireEvent.click(screen.getByTestId('private-channel-confirm'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-m/private', { method: 'POST' }));
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('says so when it fails', async () => {
    privateError = new Error('offline');
    renderAt('/channel/marketing');
    fireEvent.click(screen.getByRole('button', { name: /Make private/ }));
    fireEvent.click(await screen.findByTestId('private-channel-confirm'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith("Couldn't make the channel private. Try again."));
  });

  it('is offered only for a public channel other than #general, to its owner', () => {
    const offered = () => screen.queryByRole('button', { name: /Make private/ });
    const { unmount } = renderAt('/channel/general');
    expect(offered()).not.toBeInTheDocument();
    unmount();

    role = 'admin';
    const second = renderAt('/channel/marketing');
    expect(offered()).not.toBeInTheDocument();
    second.unmount();

    role = 'owner';
    bySlug['secret'] = { ...marketing, id: 'ch-x', slug: 'secret', name: 'secret', type: 'private' };
    bySlug['old'] = { ...marketing, id: 'ch-o', slug: 'old', name: 'old', archived: true };
    try {
      const third = renderAt('/channel/secret');
      expect(offered()).not.toBeInTheDocument();
      third.unmount();
      renderAt('/channel/old');
      expect(offered()).not.toBeInTheDocument();
    } finally {
      delete bySlug['secret'];
      delete bySlug['old'];
    }
  });
});
