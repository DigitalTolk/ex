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
    vi.useFakeTimers();
  });

  it('reads online state from PresenceContext when the prop is omitted (mention path)', async () => {
    // The mention path doesn't carry presence in the message; the hover
    // card must look it up from the global presence set so the green
    // dot renders the same way it does for author hovers.
    apiFetchMock.mockImplementation((url: string) => {
      if (url === '/api/v1/presence') return Promise.resolve({ online: ['u-bob'] });
      if (url === '/api/v1/users/u-bob')
        return Promise.resolve({ id: 'u-bob', displayName: 'Bob', status: 'active' });
      return Promise.resolve({});
    });
    renderCard({ userId: 'u-bob' });
    // Let the presence backfill resolve before opening the card.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
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
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByLabelText('Offline')).toBeInTheDocument();
    });
  });

  it('explicit online prop overrides the presence context (author path)', async () => {
    // Author hovers receive `online` from their userMap entry — that's
    // authoritative for the moment of render, so the prop wins.
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
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByLabelText('Online')).toBeInTheDocument();
    });
  });

  it('always renders the presence dot — no "missing presence = no dot" gate', async () => {
    // Earlier code only rendered the dot when `online !== undefined`, so
    // mention hovers (which never pass `online`) had no dot at all. The
    // dot is now always rendered; only its color changes.
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
    fireEvent.mouseEnter(screen.getByText('trigger'));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      expect(screen.getByTestId('hover-online-dot')).toBeInTheDocument();
    });
  });
});
