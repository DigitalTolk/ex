import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import DirectoriesPage from '@/pages/DirectoriesPage';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: [], isLoading: false }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

const mockCreateConversation = vi.fn();
vi.mock('@/hooks/useConversations', () => ({
  useCreateConversation: () => ({ mutate: mockCreateConversation, isPending: false }),
}));

const onlineSet = new Set<string>();
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: onlineSet,
    isOnline: (id: string) => onlineSet.has(id),
    setUserOnline: vi.fn(),
  }),
}));

let mockSystemRole: 'admin' | 'member' = 'admin';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', email: 'admin@x.com', displayName: 'Admin', systemRole: mockSystemRole, status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function renderWithProviders() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <DirectoriesPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('DirectoriesPage - members tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSystemRole = 'admin';
    onlineSet.clear();
  });

  it('shows online indicator and Message button for each member', async () => {
    onlineSet.add('u-1');
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
      { id: 'u-2', email: 'bob@x.com', displayName: 'Bob', systemRole: 'member', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Message Alice')).toBeInTheDocument();
    expect(screen.getByLabelText('Message Bob')).toBeInTheDocument();
    const aliceEmail = screen.getByRole('link', { name: 'alice@x.com' });
    expect(aliceEmail).toHaveClass('text-link');
    expect(aliceEmail).not.toHaveClass('hover:underline');
    const aliceDot = screen.getByTestId('presence-u-1');
    const bobDot = screen.getByTestId('presence-u-2');
    expect(aliceDot.getAttribute('aria-label')).toBe('Online');
    expect(bobDot.getAttribute('aria-label')).toBe('Offline');
  });

  it('starts a DM when Message button is clicked', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    const btn = await screen.findByLabelText('Message Alice');
    fireEvent.click(btn);
    expect(mockCreateConversation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dm', participantIDs: ['u-1'] }),
      expect.any(Object),
    );
  });

  it('shows (you) label and notes-to-self message button for self row', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-admin', email: 'admin@x.com', displayName: 'Admin', systemRole: 'admin', status: 'active' },
    ]);
    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => {
      expect(screen.getByText('(you)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Open notes-to-self')).toBeInTheDocument();
    expect(screen.queryByLabelText('Manage Admin')).not.toBeInTheDocument();
  });

  it('switches to members tab and lists users', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
      { id: 'u-2', email: 'bob@x.com', displayName: 'Bob', systemRole: 'admin', status: 'active' },
    ]);

    renderWithProviders();

    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('shows Manage button for admin viewer', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Manage Alice')).toBeInTheDocument();
    });
  });

  it('uses wrapping member cards with a full-width avatar area and kebab management menu', async () => {
    mockApiFetch.mockResolvedValue([
      {
        id: 'u-1',
        email: 'alice@x.com',
        displayName: 'Alice',
        systemRole: 'member',
        status: 'active',
        userStatus: { emoji: ':house:', text: 'Working from home' },
        timeZone: 'America/New_York',
        lastSeenAt: '2026-05-03T10:00:00.000Z',
      },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByTestId('members-grid')).toHaveClass('grid-cols-2');
    expect(screen.getByTestId('members-grid').className).toContain('md:grid-cols-[repeat(auto-fill,minmax(16rem,calc((100%_-_3rem)/5)))]');
    expect(screen.getByTestId('members-grid')).toHaveClass('md:justify-start');
    expect(screen.getByTestId('directory-user-avatar')).toHaveClass('w-full');
    expect(screen.queryByText('Working from home')).not.toBeInTheDocument();
    expect(screen.getByText('Local time')).toBeInTheDocument();
    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.getByText('Last seen')).toBeInTheDocument();
    expect(screen.getByTestId('directory-meta-local-time')).toHaveClass('md:flex', 'md:justify-between');
    expect(screen.getByText('Local time')).toHaveClass('md:font-normal');
    expect(screen.getByText('Timezone').nextElementSibling).toHaveClass('md:text-right', 'md:text-muted-foreground');
    const message = screen.getByLabelText('Message Alice');
    const manage = screen.getByLabelText('Manage Alice');
    const messageIcon = message.querySelector('svg');
    const manageIcon = manage.querySelector('svg');
    expect(messageIcon).not.toBeNull();
    expect(manageIcon).not.toBeNull();
    expect(message).toHaveClass('h-8');
    expect(manage).toHaveClass('h-8', 'w-8', 'p-0');
    expect(messageIcon).toHaveClass('h-3.5', 'w-3.5');
    expect(manageIcon).toHaveClass('h-3.5', 'w-3.5');
    expect(manage).not.toHaveTextContent('Manage');
  });

  it('does not show Manage button for non-admin viewer', async () => {
    mockSystemRole = 'member';
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Manage Alice')).not.toBeInTheDocument();
  });

  it('searches users when query is typed', async () => {
    mockApiFetch.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    const search = await screen.findByLabelText('Search members');
    await user.type(search, 'al');
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users?q=al');
    });
  });
});
