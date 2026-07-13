import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import DirectoriesPage from './DirectoriesPage';
import type { Channel, User, UserChannel } from '@/types';

const mockBrowseChannels = vi.fn();
const mockUserChannels = vi.fn();
const mockJoinChannel = vi.fn();
const mockApiFetch = vi.fn();

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => mockBrowseChannels(),
  useUserChannels: () => mockUserChannels(),
  useJoinChannel: () => ({ mutate: mockJoinChannel, isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ isOnline: () => false }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

let mockRole: 'admin' | 'member' = 'member';
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'a@b.c', displayName: 'Alice', systemRole: mockRole, status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('DirectoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue([]);
    mockRole = 'member';
    window.history.pushState({}, '', '/directory/channels');
  });

  it('shows a fallback error when the member list fails to load with a non-Error', async () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockRejectedValue('network-down-string');
    window.history.pushState({}, '', '/directory/users');
    renderWithProviders(<DirectoriesPage />);
    expect(await screen.findByText('Failed to load users')).toBeInTheDocument();
  });

  it('shows the error message when the member list fails with an Error', async () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockRejectedValue(new Error('Members API exploded'));
    window.history.pushState({}, '', '/directory/users');
    renderWithProviders(<DirectoriesPage />);
    expect(await screen.findByText('Members API exploded')).toBeInTheDocument();
  });

  it('shows phone (tel: link) and manager rows for directory-synced members', async () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockResolvedValue([
      {
        id: 'u-2',
        email: 'b@b.c',
        displayName: 'Bob',
        systemRole: 'member',
        status: 'active',
        phone: '+46 70 123 45 67',
        manager: { displayName: 'Boss Person', email: 'boss@b.c', userID: 'u-9' },
      },
      { id: 'u-3', email: 'c@b.c', displayName: 'Cara', systemRole: 'member', status: 'active' },
    ]);
    window.history.pushState({}, '', '/directory/users');
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    const phoneRow = await screen.findByTestId('directory-meta-phone');
    const tel = phoneRow.querySelector('a[href="tel:+46 70 123 45 67"]');
    expect(tel).not.toBeNull();
    expect(tel!.textContent).toBe('+46 70 123 45 67');
    expect(screen.getByTestId('directory-meta-manager').textContent).toContain('Boss Person');

    // Cara has no synced attributes — exactly one of each row exists.
    expect(screen.getAllByTestId('directory-meta-phone')).toHaveLength(1);
    expect(screen.getAllByTestId('directory-meta-manager')).toHaveLength(1);
  });

  it('shows a generic error when an admin role change rejects with a non-Error', async () => {
    mockRole = 'admin';
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/role')) return Promise.reject('boom-string');
      return Promise.resolve([{ id: 'u-2', email: 'b@b.c', displayName: 'Bob', systemRole: 'member', status: 'active' }]);
    });
    window.history.pushState({}, '', '/directory/users');
    const user = userEvent.setup();
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    await user.click(await screen.findByLabelText('Manage Bob'));
    await user.click(await screen.findByText('Promote to Admin'));
    expect(await screen.findByText('Failed to change role')).toBeInTheDocument();
  });

  it('lets an admin disable a guest account', async () => {
    mockRole = 'admin';
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    const patched: unknown[] = [];
    mockApiFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      if (url.includes('/status')) {
        patched.push(opts?.body);
        return Promise.resolve(undefined);
      }
      return Promise.resolve([
        { id: 'u-g', email: 'g@b.c', displayName: 'Guesty', systemRole: 'guest', authProvider: 'guest', status: 'active' },
      ]);
    });
    window.history.pushState({}, '', '/directory/users');
    const user = userEvent.setup();
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    await user.click(await screen.findByLabelText('Manage Guesty'));
    await user.click(await screen.findByTestId('deactivate-u-g'));
    await waitFor(() => expect(patched).toContain(JSON.stringify({ deactivated: true })));
  });

  it('lets an admin reactivate a disabled guest account', async () => {
    mockRole = 'admin';
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    const patched: unknown[] = [];
    mockApiFetch.mockImplementation((url: string, opts?: { body?: string }) => {
      if (url.includes('/status')) {
        patched.push(opts?.body);
        return Promise.resolve(undefined);
      }
      return Promise.resolve([
        { id: 'u-g', email: 'g@b.c', displayName: 'Guesty', systemRole: 'guest', authProvider: 'guest', status: 'deactivated' },
      ]);
    });
    window.history.pushState({}, '', '/directory/users');
    const user = userEvent.setup();
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    await user.click(await screen.findByLabelText('Manage Guesty'));
    await user.click(await screen.findByTestId('reactivate-u-g'));
    await waitFor(() => expect(patched).toContain(JSON.stringify({ deactivated: false })));
  });

  it('surfaces a fallback error when toggling guest status rejects with a non-Error', async () => {
    mockRole = 'admin';
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/status')) return Promise.reject('boom');
      return Promise.resolve([
        { id: 'u-g', email: 'g@b.c', displayName: 'Guesty', systemRole: 'guest', authProvider: 'guest', status: 'active' },
      ]);
    });
    window.history.pushState({}, '', '/directory/users');
    const user = userEvent.setup();
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    await user.click(await screen.findByLabelText('Manage Guesty'));
    await user.click(await screen.findByTestId('deactivate-u-g'));
    expect(await screen.findByText('Failed to update status')).toBeInTheDocument();
  });

  it('surfaces the Error message when toggling guest status rejects with an Error', async () => {
    mockRole = 'admin';
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockImplementation((url: string) => {
      if (url.includes('/status')) return Promise.reject(new Error('Status API exploded'));
      return Promise.resolve([
        { id: 'u-g', email: 'g@b.c', displayName: 'Guesty', systemRole: 'guest', authProvider: 'guest', status: 'active' },
      ]);
    });
    window.history.pushState({}, '', '/directory/users');
    const user = userEvent.setup();
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    await user.click(await screen.findByLabelText('Manage Guesty'));
    await user.click(await screen.findByTestId('deactivate-u-g'));
    // err instanceof Error → the real message surfaces, not the fallback.
    expect(await screen.findByText('Status API exploded')).toBeInTheDocument();
  });

  it('renders an empty role label without crashing when a user has no system role', async () => {
    mockRole = 'admin';
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockImplementation(() =>
      Promise.resolve([
        { id: 'u-2', email: 'b@b.c', displayName: 'Roleless', systemRole: '', status: 'active' },
      ] as unknown as User[]),
    );
    window.history.pushState({}, '', '/directory/users');
    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');

    // capitalize('') returns '' — the row still renders the display name.
    expect(await screen.findByText('Roleless')).toBeInTheDocument();
  });

  it('shows loading skeleton', () => {
    mockBrowseChannels.mockReturnValue({ data: undefined, isLoading: true });
    mockUserChannels.mockReturnValue({ data: undefined });

    const { container } = renderWithProviders(<DirectoriesPage />);

    // Should have skeleton elements visible (channels tab is default)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows "No channels available" when empty', () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByText('No channels available')).toBeInTheDocument();
  });

  it('renders page title and description', () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByText('Directory')).toBeInTheDocument();
    expect(screen.getByText(/browse channels and members/i)).toBeInTheDocument();
  });

  it('renders channel and member tabs', () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByRole('tab', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Members' })).toBeInTheDocument();
  });

  it('uses bookmarkable URLs for directory tabs', () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    window.history.pushState({}, '', '/directory/channels');

    renderWithProviders(<DirectoriesPage />);

    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    expect(window.location.pathname).toBe('/directory/users');
    fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
    expect(window.location.pathname).toBe('/directory/channels');
  });

  it('uses a two-column member grid on mobile and the dense desktop grid at larger sizes', async () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'a@b.c', displayName: 'Alice', systemRole: 'member', status: 'active' },
      { id: 'u-2', email: 'b@b.c', displayName: 'Bob', systemRole: 'member', status: 'active' },
    ]);
    window.history.pushState({}, '', '/directory/users');

    renderWithProviders(<DirectoriesPage />);

    const grid = await screen.findByTestId('members-grid');
    expect(grid).toHaveClass('grid-cols-2', 'gap-3');
    expect(grid.className).toContain('md:grid-cols-[repeat(auto-fill,minmax(16rem,calc((100%_-_3rem)/5)))]');
  });

  it('renders member avatars and falls back to initials when an avatar or name is missing', async () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'a@b.c', displayName: 'Alice Avatar', systemRole: 'member', status: 'active', avatarURL: 'https://x/a.png' },
      { id: 'u-2', email: 'b@b.c', displayName: '', systemRole: 'member', status: 'active' },
    ]);
    window.history.pushState({}, '', '/directory/users');

    renderWithProviders(<DirectoriesPage />);
    await screen.findByTestId('members-grid');
    // Both members render — the avatar member exercises the avatarURL branch,
    // the nameless member exercises the initials fallback ('?').
    expect(await screen.findByText('Alice Avatar')).toBeInTheDocument();
    expect(screen.getAllByText('?').length).toBeGreaterThan(0);
  });

  it('renders channels when data is loaded', () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        name: 'general',
        slug: 'general',
        type: 'public',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
        description: 'General discussion',
      },
      {
        id: 'ch-2',
        name: 'random',
        slug: 'random',
        type: 'public',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    mockBrowseChannels.mockReturnValue({ data: channels, isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('random')).toBeInTheDocument();
    expect(screen.getByText('General discussion')).toBeInTheDocument();
  });

  it('shows "Open" button for already joined channels', () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        name: 'general',
        slug: 'general',
        type: 'public',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const userChannels: UserChannel[] = [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
    ];

    mockBrowseChannels.mockReturnValue({ data: channels, isLoading: false });
    mockUserChannels.mockReturnValue({ data: userChannels });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByText('Join')).not.toBeInTheDocument();
  });

  it('navigates to the channel when "Open" is clicked on a joined channel', async () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        name: 'general',
        slug: 'general',
        type: 'public',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const userChannels: UserChannel[] = [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
    ];
    mockBrowseChannels.mockReturnValue({ data: channels, isLoading: false });
    mockUserChannels.mockReturnValue({ data: userChannels });

    renderWithProviders(<DirectoriesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    // Routes are keyed by slug — Open must land on /channel/<slug>.
    await waitFor(() => expect(window.location.pathname).toBe('/channel/general'));
  });

  it('refreshes the member directory when the user.updated bridge event fires', async () => {
    mockBrowseChannels.mockReturnValue({ data: [], isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });
    let displayName = 'Bob';
    mockApiFetch.mockImplementation(() =>
      Promise.resolve([
        { id: 'u-2', email: 'b@b.c', displayName, systemRole: 'member', status: 'active' },
      ]),
    );
    window.history.pushState({}, '', '/directory/users');
    renderWithProviders(<DirectoriesPage />);
    expect(await screen.findByText('Bob')).toBeInTheDocument();

    // The WS user.updated bridge dispatches ex:user-updated; the directory
    // must invalidate and refetch so the rename shows up without a reload.
    displayName = 'Bobby';
    act(() => {
      window.dispatchEvent(new CustomEvent('ex:user-updated'));
    });
    expect(await screen.findByText('Bobby')).toBeInTheDocument();
  });

  it('shows "Join" button for channels not yet joined', () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        name: 'general',
        slug: 'general',
        type: 'public',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    mockBrowseChannels.mockReturnValue({ data: channels, isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByText('Join')).toBeInTheDocument();
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
  });

  it('only shows public channels', () => {
    const channels: Channel[] = [
      {
        id: 'ch-1',
        name: 'public-ch',
        slug: 'public-ch',
        type: 'public',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ch-2',
        name: 'private-ch',
        slug: 'private-ch',
        type: 'private',
        createdBy: 'user-1',
        archived: false,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    mockBrowseChannels.mockReturnValue({ data: channels, isLoading: false });
    mockUserChannels.mockReturnValue({ data: [] });

    renderWithProviders(<DirectoriesPage />);

    expect(screen.getByText('public-ch')).toBeInTheDocument();
    expect(screen.queryByText('private-ch')).not.toBeInTheDocument();
  });
});
