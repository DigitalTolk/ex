import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({
    data: [
      { id: 'ch-1', name: 'general', slug: 'general', type: 'public', description: 'everyone' },
      { id: 'ch-2', name: 'design', slug: 'design', type: 'public', description: 'pixels' },
      { id: 'ch-3', name: 'random', slug: 'random', type: 'public', description: 'off-topic' },
    ],
    isLoading: false,
  }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(), isOnline: () => false, setUserOnline: vi.fn() }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'A', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import DirectoriesPage from '@/pages/DirectoriesPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <DirectoriesPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('DirectoriesPage — channel search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders all public channels by default', () => {
    renderPage();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.getByText('random')).toBeInTheDocument();
  });

  it('filters channels by name on search', () => {
    renderPage();
    const input = screen.getByLabelText('Search channels');
    fireEvent.change(input, { target: { value: 'des' } });
    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.queryByText('general')).toBeNull();
    expect(screen.queryByText('random')).toBeNull();
  });

  it('matches the description text too', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'topic' } });
    expect(screen.getByText('random')).toBeInTheDocument();
    expect(screen.queryByText('general')).toBeNull();
  });

  it('shows no-match copy when nothing matches', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Search channels'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matching channels')).toBeInTheDocument();
  });
});
