import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: (props: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button
      data-testid={props['data-testid'] ?? 'dropdown-item'}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
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
    user: { id: 'admin-1', email: 'a@x.com', displayName: 'Admin', systemRole: 'admin', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

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

describe('DirectoriesPage — guest activate/deactivate', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('shows "Disable guest" only for guest-auth users and PATCHes status on click', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'g-1', email: 'g@x.com', displayName: 'Guesty', systemRole: 'guest', authProvider: 'guest', status: 'active' },
      { id: 'm-1', email: 'm@x.com', displayName: 'Member', systemRole: 'member', authProvider: 'oidc', status: 'active' },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Guesty'));

    expect(screen.getByTestId('deactivate-g-1')).toBeInTheDocument();
    expect(screen.queryByTestId('deactivate-m-1')).toBeNull();

    apiFetchMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('deactivate-g-1'));

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/users/g-1/status',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ deactivated: true }),
        }),
      );
    });
    // Optimistic UI: inactive pill appears.
    await waitFor(() => {
      expect(screen.getByTestId('status-pill-g-1')).toHaveTextContent('Inactive');
    });
  });

  it('shows "Reactivate guest" for an already-deactivated guest', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'g-2', email: 'd@x.com', displayName: 'Disabled', systemRole: 'guest', authProvider: 'guest', status: 'deactivated' },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Disabled'));

    expect(screen.getByTestId('reactivate-g-2')).toBeInTheDocument();
    expect(screen.getByTestId('status-pill-g-2')).toHaveTextContent('Inactive');
  });
});
