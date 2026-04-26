import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

// Plain dropdown stubs so we can read the disabled state directly.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button data-testid="dropdown-item" onClick={onClick} disabled={disabled}>{children}</button>
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
    user: { id: 'u-admin', email: 'admin@x.com', displayName: 'Admin', systemRole: 'admin', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import DirectoriesPage from '@/pages/DirectoriesPage';

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DirectoriesPage — guest promotion blocked', () => {
  it('Promote to Admin and Set as Member are disabled for a guest user', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-guest', email: 'g@x.com', displayName: 'Guest', systemRole: 'guest', authProvider: 'guest', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByTestId('directory-user-card'));

    const items = screen.getAllByTestId('dropdown-item');
    const promote = items.find((b) => b.textContent?.includes('Promote to Admin')) as HTMLButtonElement;
    const setMember = items.find((b) => b.textContent?.includes('Set as Member')) as HTMLButtonElement;
    const setGuest = items.find((b) => b.textContent?.includes('Set as Guest')) as HTMLButtonElement;

    expect(promote.disabled).toBe(true);
    expect(setMember.disabled).toBe(true);
    // Already a guest → "Set as Guest" is also disabled (no-op).
    expect(setGuest.disabled).toBe(true);
  });

  it('Promote to Admin and Set as Member are enabled for a member', async () => {
    mockApiFetch.mockResolvedValue([
      { id: 'u-mem', email: 'm@x.com', displayName: 'Member', systemRole: 'member', authProvider: 'oidc', status: 'active' },
    ]);

    renderWithProviders();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByTestId('directory-user-card'));

    const items = screen.getAllByTestId('dropdown-item');
    const promote = items.find((b) => b.textContent?.includes('Promote to Admin')) as HTMLButtonElement;
    const setMember = items.find((b) => b.textContent?.includes('Set as Member')) as HTMLButtonElement;

    expect(promote.disabled).toBe(false);
    // Already member → no-op disable.
    expect(setMember.disabled).toBe(true);
  });
});
