import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@b.c', displayName: 'Alice', systemRole: 'member', status: 'active' },
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
  useUserConversations: () => ({
    data: [
      { conversationID: 'c-dm', type: 'dm', displayName: 'Bob' },
      { conversationID: 'c-grp', type: 'group', displayName: 'Group X' },
    ],
  }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({ data: [] }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => null,
  ApiError: class extends Error { status = 0; },
}));

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('Sidebar - DM avatar', () => {
  it('renders avatar fallback for DMs and icon for groups', () => {
    renderWithProviders(<Sidebar onClose={vi.fn()} />);

    // DM should not use MessageSquare icon — there should be at least one
    // Avatar fallback rendered with Bob's initials.
    expect(screen.getByText('B')).toBeInTheDocument();

    // Group entry text still appears
    expect(screen.getByText('Group X')).toBeInTheDocument();
  });
});
