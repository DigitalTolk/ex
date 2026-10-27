import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

vi.mock('@/hooks/useChannels', () => ({
  useBrowseChannels: () => ({ data: [], isLoading: false }),
  useUserChannels: () => ({ data: [] }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set(), isOnline: () => false, setUserOnline: vi.fn() }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', email: 'a@x.com', displayName: 'Admin', systemRole: 'admin', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import DirectoriesPage from '@/pages/DirectoriesPage';

beforeEach(() => vi.clearAllMocks());

describe('DirectoriesPage — card alignment', () => {
  // The geometry itself (actions level across a row of cards) is checked in
  // a real layout by DirectoriesPage.layout.browser.test.tsx.
  it('the user card is a column with its actions pinned to the bottom', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'a@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
    ]);

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrowserRouter>
          <DirectoriesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Alice'));

    const card = screen.getAllByTestId('directory-user-card')[0];
    expect(card).toHaveClass('flex', 'flex-col');
    // The actions container takes the leftover height's top margin, so the
    // Message button sits at the card's bottom however little is above it.
    const actions = screen.getAllByTestId('directory-card-actions')[0];
    expect(actions).toHaveClass('mt-auto');
    const buttons = actions.querySelectorAll('button, a');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0].textContent || '').toMatch(/Message/);
  });
});
