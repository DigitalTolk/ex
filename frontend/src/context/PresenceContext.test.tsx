import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { PresenceProvider, usePresence } from './PresenceContext';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let mockAuth: { isAuthenticated: boolean; user: { id: string } | null } = {
  isAuthenticated: true,
  user: { id: 'me' },
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

function Consumer({ targetId = 'u-1' }: { targetId?: string }) {
  const { online, isOnline, setUserOnline } = usePresence();
  return (
    <div>
      <span data-testid="size">{online.size}</span>
      <span data-testid="is-online">{String(isOnline(targetId))}</span>
      <button onClick={() => setUserOnline(targetId, true)}>set-online</button>
      <button onClick={() => setUserOnline(targetId, false)}>set-offline</button>
    </div>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  mockAuth = { isAuthenticated: true, user: { id: 'me' } };
});

describe('PresenceContext', () => {
  it('seeds online from /api/v1/presence and includes self', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ['u-1', 'u-2'] });
    render(
      <PresenceProvider>
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => {
      // u-1, u-2, plus self id "me" → 3
      expect(screen.getByTestId('size')).toHaveTextContent('3');
    });
    expect(screen.getByTestId('is-online')).toHaveTextContent('true');
  });

  it('does not fetch when not authenticated', async () => {
    mockAuth = { isAuthenticated: false, user: null };
    render(
      <PresenceProvider>
        <Consumer />
      </PresenceProvider>,
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('size')).toHaveTextContent('0');
  });

  it('falls back to seeding self even if backfill rejects', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('boom'));
    render(
      <PresenceProvider>
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('size')).toHaveTextContent('1');
    });
  });

  it('setUserOnline(true) adds id; toggling true→true is a no-op', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    render(
      <PresenceProvider>
        <Consumer targetId="u-3" />
      </PresenceProvider>,
    );
    // Wait for backfill to settle
    await waitFor(() => expect(screen.getByTestId('size')).toHaveTextContent('1'));
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');

    act(() => screen.getByText('set-online').click());
    expect(screen.getByTestId('is-online')).toHaveTextContent('true');
    expect(screen.getByTestId('size')).toHaveTextContent('2');

    // Setting online again — should be a no-op (same Set instance per impl).
    act(() => screen.getByText('set-online').click());
    expect(screen.getByTestId('size')).toHaveTextContent('2');
  });

  it('setUserOnline(false) removes id; toggling false→false is a no-op', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ['u-1'] });
    render(
      <PresenceProvider>
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('is-online')).toHaveTextContent('true'));

    act(() => screen.getByText('set-offline').click());
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');

    // No-op when already offline.
    act(() => screen.getByText('set-offline').click());
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');
  });

  it('usePresence outside the provider returns no-op defaults', () => {
    render(<Consumer />);
    expect(screen.getByTestId('size')).toHaveTextContent('0');
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');
    // Calling setUserOnline should not throw.
    act(() => screen.getByText('set-online').click());
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');
  });
});
