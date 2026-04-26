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
    expect(screen.queryByLabelText('Change role for Admin')).not.toBeInTheDocument();
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

  it('shows Change role button for admin viewer', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Change role for Alice')).toBeInTheDocument();
    });
  });

  it('does not show Change role button for non-admin viewer', async () => {
    mockSystemRole = 'member';
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Change role for Alice')).not.toBeInTheDocument();
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
