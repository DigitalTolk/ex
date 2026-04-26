import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import DirectoriesPage from '@/pages/DirectoriesPage';
import type { Channel } from '@/types';

const mockJoinMutate = vi.fn();

const channels: Channel[] = [
  {
    id: 'ch-new',
    name: 'new-channel',
    slug: 'new-channel',
    type: 'public',
    createdBy: 'user-1',
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: channels, isLoading: false }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: mockJoinMutate, isPending: false }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'a@b.c', displayName: 'Alice', systemRole: 'member', status: 'active' },
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

describe('DirectoriesPage - join flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls joinChannel.mutate when Join button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders();

    await user.click(screen.getByText('Join'));
    expect(mockJoinMutate).toHaveBeenCalledWith('ch-new', expect.anything());
  });
});
