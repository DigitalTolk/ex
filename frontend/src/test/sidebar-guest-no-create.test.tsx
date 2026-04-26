import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';

let mockSystemRole: 'admin' | 'member' | 'guest' = 'member';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u-1',
      email: 'a@b.c',
      displayName: 'Alice',
      systemRole: mockSystemRole,
      status: 'active',
    },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set<string>(),
    unreadConversations: new Set<string>(),
    hiddenConversations: new Set<string>(),
    hideConversation: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({ data: [] }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => null,
  ApiError: class extends Error { status = 0; },
}));

function renderWithProviders() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Sidebar onClose={vi.fn()} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('Sidebar - guest channel creation gate', () => {
  it('hides the Create channel button for guests', () => {
    mockSystemRole = 'guest';
    renderWithProviders();
    expect(screen.queryByLabelText('Create channel')).toBeNull();
  });

  it('shows the Create channel button for members', () => {
    mockSystemRole = 'member';
    renderWithProviders();
    expect(screen.getByLabelText('Create channel')).toBeInTheDocument();
  });

  it('shows the Create channel button for admins', () => {
    mockSystemRole = 'admin';
    renderWithProviders();
    expect(screen.getByLabelText('Create channel')).toBeInTheDocument();
  });
});
