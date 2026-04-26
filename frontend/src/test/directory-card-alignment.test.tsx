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
  it('the user card is items-start so cards align top regardless of action count', async () => {
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
    // Pin the alignment class so a regression that re-introduces
    // items-center (which made the Message button float) fails the test.
    expect(card.className).toContain('items-start');
    // Sanity: the actions container exists and the Message button is its
    // first interactive child (so it ends up at the top of the column).
    const actions = screen.getAllByTestId('directory-card-actions')[0];
    const buttons = actions.querySelectorAll('button, a');
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0].textContent || '').toMatch(/Message/);
  });
});
