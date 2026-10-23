import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { PresenceProvider, presenceQueryKey, presenceRetry, refreshPresence, usePresence } from './PresenceContext';
import { usePresenceStore } from '@/stores/presence';

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

let qc: QueryClient;
function renderProvider(children: ReactNode = <Consumer />) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (node: ReactNode) => (
    <QueryClientProvider client={qc}>
      <PresenceProvider>{node}</PresenceProvider>
    </QueryClientProvider>
  );
  const view = render(ui(children));
  return { ...view, rerenderProvider: () => view.rerender(ui(children)) };
}

const online = () => [...usePresenceStore.getState().online].sort();
const originalDelay = presenceRetry.delay;

beforeEach(() => {
  apiFetchMock.mockReset();
  mockAuth = { isAuthenticated: true, user: { id: 'me' } };
  // Zero delay so the failure paths don't sleep out the production curve
  // (same attempt count).
  presenceRetry.delay = () => 0;
});
afterEach(() => {
  presenceRetry.delay = originalDelay;
});

describe('PresenceProvider backfill', () => {
  it('seeds the store from /api/v1/presence and includes self', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ['u-1', 'u-2'] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('size')).toHaveTextContent('3'));
    expect(online()).toEqual(['me', 'u-1', 'u-2']);
    expect(screen.getByTestId('is-online')).toHaveTextContent('true');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/presence');
  });

  it('waits for sign-in before fetching', async () => {
    mockAuth = { isAuthenticated: false, user: null };
    apiFetchMock.mockResolvedValue({ online: ['u-1'] });
    const { rerenderProvider } = renderProvider();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('size')).toHaveTextContent('0');

    mockAuth = { isAuthenticated: true, user: { id: 'me' } };
    rerenderProvider();
    await waitFor(() => expect(online()).toEqual(['me', 'u-1']));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers after transient failures: three attempts in all', async () => {
    // One-shot fetch was the old behavior: a single failed boot request left
    // every presence dot dark for the session.
    apiFetchMock
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockResolvedValueOnce({ online: ['u-1'] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('is-online')).toHaveTextContent('true'));
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('still seeds self when every attempt fails', async () => {
    apiFetchMock.mockRejectedValue(new Error('down'));
    renderProvider();
    await waitFor(() => expect(online()).toEqual(['me']));
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('a failure with no signed-in user id seeds nobody', async () => {
    mockAuth = { isAuthenticated: true, user: null };
    apiFetchMock.mockRejectedValue(new Error('down'));
    renderProvider();
    await waitFor(() => expect(qc.getQueryState(presenceQueryKey)?.status).toBe('error'));
    expect(online()).toEqual([]);
  });

  it('takes a payload without an online list as nobody online, and seeds no self without an id', async () => {
    mockAuth = { isAuthenticated: true, user: null };
    usePresenceStore.getState().setUserOnline('stale', true);
    apiFetchMock.mockResolvedValueOnce({});
    renderProvider();
    await waitFor(() => expect(qc.getQueryState(presenceQueryKey)?.status).toBe('success'));
    expect(online()).toEqual([]);
  });

  it('refreshPresence refetches the authoritative set (reconnect reconciliation)', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    renderProvider();
    await waitFor(() => expect(online()).toEqual(['me']));
    // While disconnected, u-1 came online and u-9's event was missed too —
    // the ephemeral presence.changed was lost, so the refresh reconciles.
    act(() => usePresenceStore.getState().setUserOnline('u-9', true));
    apiFetchMock.mockResolvedValueOnce({ online: ['u-1'] });
    act(() => refreshPresence(qc));
    await waitFor(() => expect(online()).toEqual(['me', 'u-1']));
  });

  it('replaces the set even when a refresh returns the same list as before', async () => {
    apiFetchMock.mockResolvedValue({ online: ['u-1'] });
    renderProvider();
    await waitFor(() => expect(online()).toEqual(['me', 'u-1']));
    // A live event since then turned out wrong (it was missed going back).
    act(() => usePresenceStore.getState().setUserOnline('u-2', true));
    act(() => refreshPresence(qc));
    await waitFor(() => expect(online()).toEqual(['me', 'u-1']));
  });

  it('a slow older backfill cannot overwrite a newer refresh', async () => {
    let resolveFirst: (v: { online: string[] }) => void = () => undefined;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ online: ['u-1'] });
    renderProvider();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    act(() => refreshPresence(qc));
    await waitFor(() => expect(online()).toEqual(['me', 'u-1']));
    // The first response lands late with an empty set: dropped.
    await act(async () => {
      resolveFirst({ online: [] });
    });
    expect(online()).toEqual(['me', 'u-1']);
  });

  it('a slow older failure cannot undo a newer refresh', async () => {
    let rejectFirst: (e: Error) => void = () => undefined;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectFirst = rej; }))
      .mockResolvedValueOnce({ online: ['u-1'] });
    renderProvider();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    act(() => refreshPresence(qc));
    await waitFor(() => expect(online()).toEqual(['me', 'u-1']));
    await act(async () => {
      rejectFirst(new Error('late failure'));
    });
    expect(online()).toEqual(['me', 'u-1']);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('a backfill that lands after the provider unmounted changes nothing', async () => {
    let resolveFirst: (v: { online: string[] }) => void = () => undefined;
    apiFetchMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const { unmount } = renderProvider();
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolveFirst({ online: ['u-1'] });
    });
    expect(online()).toEqual([]);
  });
});

describe('usePresence', () => {
  it('reads and writes the shared store, with or without the provider', () => {
    render(<Consumer targetId="u-3" />);
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');
    act(() => screen.getByText('set-online').click());
    expect(screen.getByTestId('is-online')).toHaveTextContent('true');
    const set = usePresenceStore.getState().online;
    // Repeating a transition keeps the same set (no re-render for nothing).
    act(() => screen.getByText('set-online').click());
    expect(usePresenceStore.getState().online).toBe(set);
    act(() => screen.getByText('set-offline').click());
    expect(screen.getByTestId('is-online')).toHaveTextContent('false');
  });
});

describe('presenceRetry.delay', () => {
  it('backs off exponentially from 0.5 s to a 5 s cap, jittered to half its value at most', () => {
    const random = vi.spyOn(Math, 'random');
    try {
      random.mockReturnValue(1);
      expect([0, 1, 2, 3, 4, 8].map((n) => originalDelay(n))).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
      random.mockReturnValue(0);
      expect(originalDelay(0)).toBe(250);
    } finally {
      random.mockRestore();
    }
  });
});
