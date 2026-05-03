import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UserHoverCard } from '@/components/UserHoverCard';
import { PresenceProvider } from '@/context/PresenceContext';

// Stub the things PresenceProvider needs to mount cleanly: AuthContext for
// "authenticated user" gating, and the API fetch it backfills presence
// from. The hover-card's own lazy /users/<id> fetch shares the same mock.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-me', displayName: 'Me', email: 'me@x.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function renderCard(props: { userId: string; online?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PresenceProvider>
          <UserHoverCard
            userId={props.userId}
            displayName="Bob"
            currentUserId="u-me"
            online={props.online}
          >
            <span>trigger</span>
          </UserHoverCard>
        </PresenceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UserHoverCard — presence fallback for mentions', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('reads online state from PresenceContext when the prop is omitted (mention path)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: ['u-bob'] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({ id: 'u-bob', displayName: 'Bob', status: 'active' });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob' });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('trigger'));
    await waitFor(() => {
      expect(screen.getByLabelText('Online')).toBeInTheDocument();
    });
  });

  it('shows Offline when the user is not in the online set', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: [] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({ id: 'u-bob', displayName: 'Bob', status: 'active' });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob' });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('trigger'));
    await waitFor(() => {
      expect(screen.getByLabelText('Offline')).toBeInTheDocument();
    });
  });

  it('explicit online prop overrides the presence context (author path)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: [] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({ id: 'u-bob', displayName: 'Bob', status: 'active' });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob', online: true });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('trigger'));
    await waitFor(() => {
      expect(screen.getByLabelText('Online')).toBeInTheDocument();
    });
  });

  it('always renders the presence dot — no "missing presence = no dot" gate', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: [] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({ id: 'u-bob', displayName: 'Bob', status: 'active' });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob' });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('hover-online-dot')).toBeInTheDocument();
    });
  });

  it('renders email as mailto, online last-seen as now, and status clear text as a title', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: ['u-bob'] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({
          id: 'u-bob',
          displayName: 'Bob',
          email: 'bob@example.com',
          status: 'active',
          lastSeenAt: '2026-05-03T10:00:00.000Z',
          timeZone: 'America/New_York',
          userStatus: { emoji: ':house:', text: 'Working from home', clearAt: '2030-05-03T12:30:00.000Z' },
        });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob' });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('trigger'));

    expect(await screen.findByRole('link', { name: 'bob@example.com' })).toHaveAttribute('href', 'mailto:bob@example.com');
    expect(screen.getByText('now')).toBeInTheDocument();
    expect(screen.getByText('Working from home')).toBeInTheDocument();
    expect(screen.getByTestId('hover-card-header')).toHaveClass('items-start');
    expect(screen.getByTestId('hover-status-line')).toHaveClass('whitespace-normal');
    expect(screen.getByTestId('hover-status-line')).toHaveClass('break-words');
    expect(screen.getByTestId('hover-status-line')).toHaveAttribute('title', expect.stringMatching(/^until /));
    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.getByText('New York, America')).toBeInTheDocument();
  });

  it('does not crash or render local time when persisted timezone is invalid', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: [] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({
          id: 'u-bob',
          displayName: 'Bob',
          email: 'bob@example.com',
          status: 'active',
          timeZone: 'Not/AZone',
        });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob' });
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('trigger'));

    expect(await screen.findByText('bob@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Local time')).not.toBeInTheDocument();
    expect(screen.queryByText('Timezone')).not.toBeInTheDocument();
  });
});
