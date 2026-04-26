import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('DirectoriesPage — readable text sizes', () => {
  it('email and role render at text-sm (14px), not text-xs/[10px]', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-1', email: 'alice@x.com', displayName: 'Alice', systemRole: 'member', status: 'active' },
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

    const email = screen.getByText('alice@x.com');
    expect(email.className).toContain('text-sm');
    expect(email.className).not.toContain('text-xs');

    const role = screen.getByText('member');
    expect(role.className).toContain('text-sm');
    expect(role.className).not.toContain('text-[10px]');
  });
});
