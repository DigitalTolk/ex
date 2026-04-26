import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockJoinMutate = vi.fn();
vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({
    data: [
      { id: 'ch-marketing', name: 'Marketing', slug: 'marketing', type: 'public' },
    ],
    isLoading: false,
  }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: mockJoinMutate, isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(), isOnline: () => false, setUserOnline: vi.fn() }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import DirectoriesPage from '@/pages/DirectoriesPage';

beforeEach(() => {
  mockNavigate.mockReset();
  mockJoinMutate.mockReset();
});

describe('DirectoriesPage — Join redirects to the channel', () => {
  it('clicking Join calls the join mutation and navigates to the channel slug on success', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <DirectoriesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /join/i }));
    await waitFor(() => expect(mockJoinMutate).toHaveBeenCalled());

    // Simulate the mutation succeeding by invoking the onSuccess callback
    // the component passed in.
    const opts = mockJoinMutate.mock.calls[0][1] as { onSuccess: () => void };
    opts.onSuccess();

    expect(mockNavigate).toHaveBeenCalledWith('/channel/marketing');
  });
});
