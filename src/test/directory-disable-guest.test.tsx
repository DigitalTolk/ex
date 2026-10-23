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
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
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

describe('DirectoriesPage — account activate/deactivate', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // Any account but your own can be deactivated (the API refuses only
  // self-deactivation): SSO accounts too, since the IdP stops new logins but
  // only this ends the sessions and automations an account already has.
  it('offers Deactivate for guest and SSO accounts alike, never for yourself', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'admin-1', email: 'a@x.com', displayName: 'Admin', systemRole: 'admin', authProvider: 'oidc', status: 'active' },
      { id: 'g-1', email: 'g@x.com', displayName: 'Guesty', systemRole: 'guest', authProvider: 'guest', status: 'active' },
      { id: 'm-1', email: 'm@x.com', displayName: 'Mia', systemRole: 'member', authProvider: 'oidc', status: 'active' },
      { id: 'o-1', email: 'o@x.com', displayName: 'Other Admin', systemRole: 'admin', authProvider: 'oidc', status: 'active' },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Guesty'));

    expect(screen.getByTestId('deactivate-g-1')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-m-1')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-o-1')).toBeInTheDocument();
    expect(screen.queryByTestId('deactivate-admin-1')).toBeNull();
  });

  it('deactivates an SSO member after confirming, and the card shows Inactive', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'm-1', email: 'm@x.com', displayName: 'Mia', systemRole: 'member', authProvider: 'oidc', status: 'active' },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Mia'));

    fireEvent.click(screen.getByTestId('deactivate-m-1'));
    // Nothing is sent until the admin confirms.
    expect(await screen.findByTestId('deactivate-user')).toHaveTextContent('Deactivate Mia?');
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    apiFetchMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('deactivate-user-confirm'));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/users/m-1/status',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ deactivated: true }) }),
      );
    });
    expect(await screen.findByTestId('status-pill-m-1')).toHaveTextContent('Inactive');
    expect(screen.getByTestId('reactivate-m-1')).toBeInTheDocument();
  });

  it('cancelling the confirm leaves the account active', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'm-1', email: 'm@x.com', displayName: 'Mia', systemRole: 'member', authProvider: 'oidc', status: 'active' },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Mia'));

    fireEvent.click(screen.getByTestId('deactivate-m-1'));
    fireEvent.click(await screen.findByTestId('deactivate-user-cancel'));
    await waitFor(() => expect(screen.queryByTestId('deactivate-user')).toBeNull());
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('status-pill-m-1')).toBeNull();
  });

  it('reactivates without a confirm, for an SSO account too', async () => {
    apiFetchMock.mockResolvedValueOnce([
      { id: 'm-2', email: 'd@x.com', displayName: 'Disabled', systemRole: 'member', authProvider: 'oidc', status: 'deactivated' },
    ]);
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Members' }));
    await waitFor(() => screen.getByText('Disabled'));
    expect(screen.getByTestId('status-pill-m-2')).toHaveTextContent('Inactive');

    apiFetchMock.mockResolvedValueOnce({});
    fireEvent.click(screen.getByTestId('reactivate-m-2'));
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/v1/users/m-2/status',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ deactivated: false }) }),
      );
    });
    await waitFor(() => expect(screen.queryByTestId('status-pill-m-2')).toBeNull());
  });

  it('shows Reactivate for an already-deactivated guest', async () => {
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
