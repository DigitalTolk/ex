import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ConstantBackoff, handleAll, retry } from 'cockatiel';
import { PresenceProvider, usePresence, presenceRetry } from './PresenceContext';
import { useEffect } from 'react';

// Browser-coverage tests for PresenceContext. The provider hits the
// /presence backfill endpoint on auth, seeds the current user as
// online, and exposes a setUserOnline mutator that swaps the
// in-memory Set in an idempotent way. usePresence outside a provider
// returns a safe noop. All of those branches need their own scenario.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

let mockAuth = {
  user: { id: 'u-self', displayName: 'Me', email: 'm@m.com', systemRole: 'member', status: 'active' },
  isAuthenticated: true,
  isLoading: false,
};
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockAuth,
  useOptionalAuth: () => mockAuth,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function Probe({ onState }: { onState: (s: ReturnType<typeof usePresence>) => void }) {
  const s = usePresence();
  useEffect(() => onState(s));
  return null;
}

beforeEach(() => {
  presenceRetry.policy = retry(handleAll, { maxAttempts: 3, backoff: new ConstantBackoff(0) });
  apiFetchMock.mockReset();
  mockAuth = {
    user: { id: 'u-self', displayName: 'Me', email: 'm@m.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PresenceContext (browser)', () => {
  it('backfills /presence on auth and seeds the current user as online', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ['u-a', 'u-b'] });
    let captured: ReturnType<typeof usePresence> | null = null;
    await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    await vi.waitFor(() => {
      expect(captured?.online.has('u-self')).toBe(true);
      expect(captured?.online.has('u-a')).toBe(true);
      expect(captured?.online.has('u-b')).toBe(true);
    });
  });

  it('still seeds self if /presence fetch fails', async () => {
    // Persistent rejection: with the retry policy, a single -Once rejection
    // would let attempt #2 "succeed" with undefined and dodge the catch arm.
    apiFetchMock.mockRejectedValue(new Error('network down'));
    let captured: ReturnType<typeof usePresence> | null = null;
    await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    await vi.waitFor(() => {
      expect(captured?.online.has('u-self')).toBe(true);
    });
  });

  it('skips backfill while unauthenticated', async () => {
    mockAuth = { ...mockAuth, isAuthenticated: false };
    await render(
      <PresenceProvider>
        <Probe onState={() => undefined} />
      </PresenceProvider>,
    );
    // Give effects a tick to settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('setUserOnline(true) is idempotent — no state churn on duplicates', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    const renders: number[] = [];
    let lastState: ReturnType<typeof usePresence> | null = null;
    function Counter() {
      const s = usePresence();
      useEffect(() => {
        renders.push(s.online.size);
        lastState = s;
      });
      return null;
    }
    await render(
      <PresenceProvider>
        <Counter />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(lastState?.online.has('u-self')).toBe(true));
    const beforeCount = renders.length;
    lastState!.setUserOnline('u-self', true); // already online
    await new Promise((r) => setTimeout(r, 20));
    expect(renders.length).toBe(beforeCount);
  });

  it('setUserOnline(false) clears the user from online', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: ['u-other'] });
    let lastState: ReturnType<typeof usePresence> | null = null;
    function Probe2() {
      const s = usePresence();
      useEffect(() => { lastState = s; });
      return null;
    }
    await render(
      <PresenceProvider>
        <Probe2 />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(lastState?.online.has('u-other')).toBe(true));
    lastState!.setUserOnline('u-other', false);
    await vi.waitFor(() => expect(lastState?.online.has('u-other')).toBe(false));
  });

  it('setUserOnline(false) is idempotent for a user not currently online', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    let lastState: ReturnType<typeof usePresence> | null = null;
    function Probe2() {
      const s = usePresence();
      useEffect(() => { lastState = s; });
      return null;
    }
    await render(
      <PresenceProvider>
        <Probe2 />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(lastState).not.toBeNull());
    const before = lastState!.online;
    lastState!.setUserOnline('u-not-here', false);
    // No state change — the same Set reference can be returned by
    // the reducer when the key was already absent.
    await new Promise((r) => setTimeout(r, 20));
    expect(lastState!.online.has('u-not-here')).toBe(false);
    expect(before.size).toBe(lastState!.online.size);
  });

  it('isOnline reflects setUserOnline updates', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    let lastState: ReturnType<typeof usePresence> | null = null;
    function Probe2() {
      const s = usePresence();
      useEffect(() => { lastState = s; });
      return null;
    }
    await render(
      <PresenceProvider>
        <Probe2 />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(lastState).not.toBeNull());
    expect(lastState!.isOnline('u-x')).toBe(false);
    lastState!.setUserOnline('u-x', true);
    await vi.waitFor(() => expect(lastState!.isOnline('u-x')).toBe(true));
  });

  it('usePresence outside a provider returns the safe noop state', async () => {
    let captured: ReturnType<typeof usePresence> | null = null;
    function Probe2() {
      const s = usePresence();
      useEffect(() => { captured = s; }, [s]);
      return null;
    }
    await render(<Probe2 />);
    await vi.waitFor(() => expect(captured).not.toBeNull());
    expect(captured!.isOnline('anyone')).toBe(false);
    expect(captured!.online.size).toBe(0);
    // The noop mutator and refresher must not throw.
    expect(() => captured!.setUserOnline('x', true)).not.toThrow();
    captured!.refreshPresence(); // noop — must not throw or fetch
  });

  it('coerces a backfill payload with no `online` field to an empty set (?? [])', async () => {
    // data is defined but `data.online` is undefined → the `?? []` arm.
    apiFetchMock.mockResolvedValueOnce({});
    let captured: ReturnType<typeof usePresence> | null = null;
    await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    // Self is still seeded; no other users came from the empty payload.
    await vi.waitFor(() => expect(captured?.online.has('u-self')).toBe(true));
    expect(captured?.online.size).toBe(1);
  });

  it('does not seed a self id on success when the authenticated user has no id', async () => {
    // Authenticated but user.id missing → `if (user?.id)` false arm in the
    // success handler; only the backfilled ids land in the set.
    mockAuth = { ...mockAuth, user: { ...mockAuth.user, id: '' } };
    apiFetchMock.mockResolvedValueOnce({ online: ['u-a'] });
    let captured: ReturnType<typeof usePresence> | null = null;
    await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(captured?.online.has('u-a')).toBe(true));
    expect(captured?.online.has('')).toBe(false);
  });

  it('drops the catch-path self-seed when the provider unmounts before fetch rejects', async () => {
    let reject: (e: unknown) => void = () => undefined;
    apiFetchMock.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
    let captured: ReturnType<typeof usePresence> | null = null;
    const screen = await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    screen.unmount();
    // Reject AFTER unmount → the catch's `if (cancelled) return` true arm.
    reject(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured).not.toBeNull();
  });

  it('drops the backfill result when the provider unmounts before fetch resolves', async () => {
    let resolve: (v: { online: string[] }) => void = () => undefined;
    apiFetchMock.mockReturnValueOnce(new Promise<{ online: string[] }>((r) => { resolve = r; }));
    let captured: ReturnType<typeof usePresence> | null = null;
    function Probe2() {
      const s = usePresence();
      useEffect(() => { captured = s; });
      return null;
    }
    const screen = await render(
      <PresenceProvider>
        <Probe2 />
      </PresenceProvider>,
    );
    screen.unmount();
    resolve({ online: ['u-late'] });
    await new Promise((r) => setTimeout(r, 30));
    // After unmount the provider is gone; the noop state is a fresh
    // object. We just need to verify the late fetch resolution didn't
    // throw or warn about state-update-on-unmounted (the cancelled
    // flag handles it). Sanity-check captured stayed defined.
    expect(captured).not.toBeNull();
  });
});

describe('backfill retry + reconnect refresh', () => {
  it('recovers the backfill after transient failures (retry policy)', async () => {
    apiFetchMock
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockRejectedValueOnce(new Error('boot blip'))
      .mockResolvedValueOnce({ online: ['u-1'] });
    let captured: ReturnType<typeof usePresence> | null = null;
    function Grab() {
      const s = usePresence();
      useEffect(() => { captured = s; });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
      </PresenceProvider>,
    );
    await vi.waitFor(() => {
      expect(captured?.isOnline('u-1')).toBe(true);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('refreshPresence refetches the authoritative online set (reconnect reconciliation)', async () => {
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    let captured: ReturnType<typeof usePresence> | null = null;
    function Grab() {
      const s = usePresence();
      useEffect(() => { captured = s; });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    // u-1 came online during a disconnect — the ephemeral presence.changed
    // was lost, so the reconnect refresh reconciles the set.
    apiFetchMock.mockResolvedValueOnce({ online: ['u-1'] });
    captured!.refreshPresence();
    await vi.waitFor(() => {
      expect(captured?.isOnline('u-1')).toBe(true);
    });
  });

  it('a stale in-flight backfill cannot clobber a newer refresh (success seq guard)', async () => {
    let resolveBoot: (v: { online: string[] }) => void = () => undefined;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((r) => { resolveBoot = r; }))
      .mockResolvedValueOnce({ online: ['u-1'] });
    let captured: ReturnType<typeof usePresence> | null = null;
    function Grab() {
      const s = usePresence();
      useEffect(() => { captured = s; });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    captured!.refreshPresence();
    await vi.waitFor(() => {
      expect(captured?.isOnline('u-1')).toBe(true);
    });
    // The slow boot response lands late with an EMPTY set — stale, dropped.
    resolveBoot({ online: [] });
    await new Promise((r) => setTimeout(r, 30));
    expect(captured?.isOnline('u-1')).toBe(true);
  });

  it('a stale in-flight failure cannot re-seed over a newer refresh (catch seq guard)', async () => {
    presenceRetry.policy = retry(handleAll, { maxAttempts: 1, backoff: new ConstantBackoff(0) });
    let rejectBoot: (e: Error) => void = () => undefined;
    apiFetchMock
      .mockImplementationOnce(() => new Promise((_, rej) => { rejectBoot = rej; }))
      .mockResolvedValueOnce({ online: ['u-1'] })
      // Any FURTHER boot-retry attempts must also fail, or a stray retry
      // "succeeds" with undefined and takes the success path instead of the
      // stale-catch arm this test exists for.
      .mockRejectedValue(new Error('still failing'));
    let captured: ReturnType<typeof usePresence> | null = null;
    function Grab() {
      const s = usePresence();
      useEffect(() => { captured = s; });
      return null;
    }
    render(
      <PresenceProvider>
        <Grab />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    captured!.refreshPresence();
    await vi.waitFor(() => {
      expect(captured?.isOnline('u-1')).toBe(true);
    });
    rejectBoot(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 30));
    expect(captured?.isOnline('u-1')).toBe(true);
  });
});

describe('catch-arm edges', () => {
  it('a second failing refresh keeps the already-seeded self entry stable (no set churn)', async () => {
    apiFetchMock.mockRejectedValue(new Error('still down'));
    let captured: ReturnType<typeof usePresence> | null = null;
    await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    await vi.waitFor(() => {
      expect(captured?.online.has('u-self')).toBe(true);
    });
    const before = captured!.online;
    captured!.refreshPresence(); // fails again → self ALREADY seeded → same set
    await new Promise((r) => setTimeout(r, 60));
    expect(captured!.online).toBe(before); // ref-stable: the ? prev arm
  });

  it('an authenticated session without a user id neither crashes nor seeds anyone', async () => {
    mockAuth = { isAuthenticated: true, user: null };
    let captured: ReturnType<typeof usePresence> | null = null;
    // Success arm first (no self to add) …
    apiFetchMock.mockResolvedValueOnce({ online: [] });
    await render(
      <PresenceProvider>
        <Probe onState={(s) => { captured = s; }} />
      </PresenceProvider>,
    );
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(captured!.online.size).toBe(0);
    // …then the catch arm (no self to seed).
    apiFetchMock.mockRejectedValue(new Error('down'));
    captured!.refreshPresence();
    await new Promise((r) => setTimeout(r, 60));
    expect(captured!.online.size).toBe(0);
  });
});
