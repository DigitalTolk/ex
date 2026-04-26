import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

// Mock dropdown to a simple structure so we can click items in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...rest }: { children: React.ReactNode; 'aria-label'?: string }) => (
    <button data-testid="dropdown-trigger" aria-label={rest['aria-label']}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="dropdown-item" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: [], isLoading: false }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
}));

const mockUser = {
  id: 'admin-1',
  email: 'admin@x.com',
  displayName: 'Admin',
  systemRole: 'admin' as const,
  status: 'active',
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import DirectoriesPage from './DirectoriesPage';

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function gotoMembersTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: 'Members' }));
  vi.advanceTimersByTime(300);
}

describe('DirectoriesPage - Members tab', () => {
  it('loads users on Members tab and shows them', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
      { id: 'u-2', email: 'bob@x.com', displayName: 'Bob', systemRole: 'guest', status: 'active' },
      { id: 'admin-1', email: 'admin@x.com', displayName: 'Admin', systemRole: 'admin', status: 'active' },
    ]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users');
    });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('searches users with query parameter when query length >= 2', async () => {
    mockApiFetch.mockResolvedValue([]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);

    const search = screen.getByLabelText('Search members');
    await user.type(search, 'al');
    vi.advanceTimersByTime(300);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users?q=al');
    });
  });

  it('shows error message when user fetch fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('shows "No members found" empty state', async () => {
    mockApiFetch.mockResolvedValue([]);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);

    expect(await screen.findByText('No members found')).toBeInTheDocument();
  });

  it('admin can promote a member to admin via role dropdown', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);
    mockApiFetch.mockResolvedValueOnce({});

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);
    await screen.findByText('Alice');

    const items = screen.getAllByTestId('dropdown-item');
    const promote = items.find((b) => b.textContent?.includes('Promote to Admin'));
    expect(promote).toBeDefined();
    fireEvent.click(promote!);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/users/u-1/role',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ role: 'admin' }),
        }),
      );
    });

    // Optimistic update: role label flips to "admin"
    await waitFor(() => {
      expect(screen.getByText('admin')).toBeInTheDocument();
    });
  });

  it('admin can set member as guest via role dropdown', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-2', email: 'bob@x.com', displayName: 'Bob', systemRole: 'member', status: 'active' },
    ]);
    mockApiFetch.mockResolvedValueOnce({});

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);
    await screen.findByText('Bob');

    const items = screen.getAllByTestId('dropdown-item');
    const setGuest = items.find((b) => b.textContent?.includes('Set as Guest'));
    fireEvent.click(setGuest!);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/users/u-2/role',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ role: 'guest' }),
        }),
      );
    });
  });

  it('admin can demote a fellow admin to member via role dropdown', async () => {
    // Promotions to member/admin are SSO-only: a guest target would have
    // both options disabled. To exercise the Set-as-Member happy path we
    // demote an existing admin instead.
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-3', email: 'c@x.com', displayName: 'Charlie', systemRole: 'admin', authProvider: 'oidc', status: 'active' },
    ]);
    mockApiFetch.mockResolvedValueOnce({});

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);
    await screen.findByText('Charlie');

    const items = screen.getAllByTestId('dropdown-item');
    const setMember = items.find((b) => b.textContent?.includes('Set as Member'));
    fireEvent.click(setMember!);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/users/u-3/role',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ role: 'member' }),
        }),
      );
    });
  });

  it('shows error in MembersTab when changeRole API fails', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);
    mockApiFetch.mockRejectedValueOnce(new Error('forbidden'));

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<DirectoriesPage />);

    await gotoMembersTab(user);
    await screen.findByText('Alice');

    const items = screen.getAllByTestId('dropdown-item');
    const promote = items.find((b) => b.textContent?.includes('Promote to Admin'));
    fireEvent.click(promote!);

    expect(await screen.findByRole('alert')).toHaveTextContent('forbidden');
  });
});
