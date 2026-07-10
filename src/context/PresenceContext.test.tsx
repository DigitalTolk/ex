import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ConstantBackoff, handleAll, retry } from 'cockatiel';
import { PresenceProvider, usePresence, presenceRetry } from './PresenceContext';

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
  // Zero-backoff retry so failure-path tests don't sleep out the
  // production curve (same attempt count, no delays).
  presenceRetry.policy = retry(handleAll, { maxAttempts: 3, backoff: new ConstantBackoff(0) });
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


describe('presence backfill retry + reconnect refresh', () => {
  it('recovers the backfill after transient failures (retry policy)', async () => {
    // One-shot fetch was the old behavior: a single failed boot request left
    // every presence dot dark for the session. The policy retries it.
    apiFetchMock
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockResolvedValueOnce({ online: ['u-1'] });
    render(
      <PresenceProvider>
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('is-online').textContent).toBe('true'));
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshPresence refetches the authoritative set (reconnect reconciliation)', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    let refresh: (() => void) | null = null;
    function Grab() {
      const { refreshPresence } = usePresence();
      useEffect(() => {
        refresh = refreshPresence;
      });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    // While disconnected, u-1 came online — the ephemeral presence.changed
    // was lost, so the reconnect refresh is what reconciles the set.
    apiFetchMock.mockResolvedValueOnce({ online: ['u-1'] });
    act(() => refresh!());
    await waitFor(() => expect(screen.getByTestId('is-online').textContent).toBe('true'));
  });

  it('a stale in-flight backfill cannot clobber a newer refresh (seq guard)', async () => {
    let resolveFirst: (v: { online: string[] }) => void = () => undefined;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; })) // slow boot fetch
      .mockResolvedValueOnce({ online: ['u-1'] }); // fast reconnect refresh
    let refresh: (() => void) | null = null;
    function Grab() {
      const { refreshPresence } = usePresence();
      useEffect(() => {
        refresh = refreshPresence;
      });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    act(() => refresh!()); // newer refresh wins the seq
    await waitFor(() => expect(screen.getByTestId('is-online').textContent).toBe('true'));
    // The slow FIRST response lands late with an empty set — it must be dropped.
    act(() => resolveFirst({ online: [] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('is-online').textContent).toBe('true');
  });

  it('a stale in-flight failure cannot re-seed over a newer refresh (seq guard, catch arm)', async () => {
    // Single-attempt policy so the held boot fetch's rejection IS the final
    // failure (no retry chain to interleave with the newer refresh).
    presenceRetry.policy = retry(handleAll, { maxAttempts: 1, backoff: new ConstantBackoff(0) });
    let rejectBoot: (e: Error) => void = () => undefined;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectBoot = rej; }))
      .mockResolvedValueOnce({ online: ['u-1'] })
      // Any FURTHER boot-retry attempts must also fail, or a stray retry
      // "succeeds" with undefined and takes the success path instead of the
      // stale-catch arm this test exists for.
      .mockRejectedValue(new Error('still failing'));
    let refresh: (() => void) | null = null;
    function Grab() {
      const { refreshPresence } = usePresence();
      useEffect(() => {
        refresh = refreshPresence;
      });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
        <Consumer />
      </PresenceProvider>,
    );
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    act(() => refresh!());
    await waitFor(() => expect(screen.getByTestId('is-online').textContent).toBe('true'));
    // The abandoned boot attempt fails late — stale seq, dropped (must not
    // re-seed the set down to just self).
    act(() => rejectBoot(new Error('late failure')));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('is-online').textContent).toBe('true');
  });
});
