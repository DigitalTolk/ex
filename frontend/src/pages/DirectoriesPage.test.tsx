import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import DirectoriesPage from './DirectoriesPage';
import type { Channel, UserChannel } from '@/types';

const mockBrowseChannels = vi.fn();
const mockUserChannels = vi.fn();
const mockJoinChannel = vi.fn();

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => mockBrowseChannels(),
  useUserChannels: () => mockUserChannels(),
  useJoinChannel: () => ({ mutate: mockJoinChannel, isPending: false }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'a@b.c', displayName: 'Alice', systemRole: 'member', status: 'active' },
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
