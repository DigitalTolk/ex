import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { AuthProvider, useAuth, useOptionalAuth } from './AuthContext';

const apiFetchMock = vi.hoisted(() => vi.fn());
const setAccessTokenMock = vi.hoisted(() => vi.fn());
const clearAccessTokenMock = vi.hoisted(() => vi.fn());
const refreshAccessTokenMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const identifyMock = vi.hoisted(() => vi.fn());
const clearMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  setAccessToken: setAccessTokenMock,
  clearAccessToken: clearAccessTokenMock,
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  refreshAccessToken: () => refreshAccessTokenMock(),
}));

vi.mock('@/lib/mobile-push-identity', () => ({
  identifyMobilePushUser: (...args: unknown[]) => identifyMock(...args),
  clearMobilePushUser: () => clearMock(),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
  setAccessTokenMock.mockReset();
  clearAccessTokenMock.mockReset();
  refreshAccessTokenMock.mockReset();
  identifyMock.mockReset().mockResolvedValue(undefined);
  clearMock.mockReset().mockResolvedValue(undefined);
});

function Probe() {
  const a = useAuth();
  return (
    <div>
      <span data-testid="state" data-loading={a.isLoading} data-auth={a.isAuthenticated}>{a.user?.displayName ?? '(none)'}</span>
      <button data-testid="logout" onClick={() => void a.logout()} />
      <button data-testid="set-auth" onClick={() => a.setAuth('t-1', { id: 'u-2', email: 'b@x.io', displayName: 'Bob', systemRole: 'member', status: 'active' })} />
      <button data-testid="patch" onClick={() => a.patchUser({ displayName: 'Patched' })} />
    </div>
  );
}

describe('AuthContext', () => {
  it('useOptionalAuth returns null outside the AuthProvider', async () => {
    function Probe2() {
      const v = useOptionalAuth();
      return <span data-testid="opt">{v === null ? 'null' : 'set'}</span>;
    }
    const screen = await render(<Probe2 />);
    expect(screen.getByTestId('opt').element().textContent).toBe('null');
  });

  it('restores the session via refreshAccessToken + /users/me on mount', async () => {
    refreshAccessTokenMock.mockResolvedValue('t-1');
    apiFetchMock.mockResolvedValue({
      id: 'u-1', email: 'a@x.io', displayName: 'Alice', systemRole: 'member', status: 'active',
    });
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('state').element().textContent).toBe('Alice');
    expect(screen.getByTestId('state').element().getAttribute('data-auth')).toBe('true');
    expect(setAccessTokenMock).toHaveBeenCalledWith('t-1');
    expect(identifyMock).toHaveBeenCalled();
  });

  it('retries the session restore with backoff after a network-level failure', async () => {
    // Regression for the blank-boot-screen bug: a network-failed (or
    // timed-out) restore must retry, not park isLoading forever and not
    // bounce a valid session to /login.
    refreshAccessTokenMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('t-recovered');
    apiFetchMock.mockResolvedValue({
      id: 'u-1', email: 'a@x.io', displayName: 'Alice', systemRole: 'member', status: 'active',
    });
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    // Still loading (NOT logged out) through the first backoff window.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('state').element().getAttribute('data-loading')).toBe('true');
    // First retry fires after the 1s backoff step and succeeds. Poll instead
    // of a fixed sleep: under full-suite CPU load the timer + refresh + render
    // chain can exceed any fixed slack (webkit flake).
    await vi.waitFor(() => {
      expect(screen.getByTestId('state').element().textContent).toBe('Alice');
    }, { timeout: 15000 });
    expect(screen.getByTestId('state').element().getAttribute('data-loading')).toBe('false');
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it('leaves the user unauthenticated when refreshAccessToken yields null', async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('state').element().textContent).toBe('(none)');
    expect(screen.getByTestId('state').element().getAttribute('data-auth')).toBe('false');
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('retries a failed /users/me boot fetch after a successful refresh', async () => {
    // The restore loop must also survive the second boot request failing at
    // the network level — refresh again and complete once the network is back.
    refreshAccessTokenMock.mockResolvedValue('t-1');
    apiFetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        id: 'u-1', email: 'a@x.io', displayName: 'Alice', systemRole: 'member', status: 'active',
      });
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    // Still loading (NOT bounced to login) while the 1s backoff runs.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getByTestId('state').element().getAttribute('data-loading')).toBe('true');
    // Poll for the recovered session — a fixed sleep races the timer chain
    // under load (same hardening as the network-failure retry test above).
    await vi.waitFor(() => {
      expect(screen.getByTestId('state').element().textContent).toBe('Alice');
    }, { timeout: 15000 });
    expect(screen.getByTestId('state').element().getAttribute('data-loading')).toBe('false');
  });

  it('setAuth updates user state and persists the token', async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    (screen.getByTestId('set-auth').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByTestId('state').element().textContent).toBe('Bob');
    expect(setAccessTokenMock).toHaveBeenCalledWith('t-1');
  });

  it('patchUser merges into the current user but is a no-op when no user is set', async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    (screen.getByTestId('patch').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    // No user → patch is a no-op.
    expect(screen.getByTestId('state').element().textContent).toBe('(none)');

    // Now sign in and patch.
    (screen.getByTestId('set-auth').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    (screen.getByTestId('patch').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('state').element().textContent).toBe('Patched');
  });

  it('logout POSTs to /auth/logout, clears the token, clears the user', async () => {
    refreshAccessTokenMock.mockResolvedValue('t-1');
    apiFetchMock.mockResolvedValue({
      id: 'u-1', email: 'a@x.io', displayName: 'Alice', systemRole: 'member', status: 'active',
    });
    globalThis.fetch = fetchMock as never;
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    (screen.getByTestId('logout').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock.mock.calls[0][0]).toBe('/auth/logout');
    expect(clearAccessTokenMock).toHaveBeenCalled();
    expect(screen.getByTestId('state').element().textContent).toBe('(none)');
  });

  it('logout tolerates a fetch rejection', async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    globalThis.fetch = fetchMock as never;
    fetchMock.mockRejectedValue(new Error('offline'));
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    (screen.getByTestId('logout').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 100));
    expect(clearAccessTokenMock).toHaveBeenCalled();
  });

  it('a failed mobile-push identify never blocks the boot restore', async () => {
    // The identity handoff is fire-and-forget: its rejection is swallowed by
    // the .catch(() => undefined) arm and the session still restores.
    refreshAccessTokenMock.mockResolvedValue('t-1');
    apiFetchMock.mockResolvedValue({
      id: 'u-1', email: 'a@x.io', displayName: 'Alice', systemRole: 'member', status: 'active',
    });
    identifyMock.mockRejectedValue(new Error('no native bridge'));
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId('state').element().textContent).toBe('Alice');
      expect(screen.getByTestId('state').element().getAttribute('data-loading')).toBe('false');
    });
    expect(identifyMock).toHaveBeenCalledTimes(1);
  });

  it('setAuth tolerates a failed mobile-push identify', async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    identifyMock.mockRejectedValue(new Error('no native bridge'));
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await new Promise((r) => setTimeout(r, 200));
    (screen.getByTestId('set-auth').element() as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 100));
    // The rejection was swallowed; the sign-in landed regardless.
    expect(screen.getByTestId('state').element().textContent).toBe('Bob');
    expect(identifyMock).toHaveBeenCalled();
  });

  it('logout tolerates a failed mobile-push clear', async () => {
    refreshAccessTokenMock.mockResolvedValue('t-1');
    apiFetchMock.mockResolvedValue({
      id: 'u-1', email: 'a@x.io', displayName: 'Alice', systemRole: 'member', status: 'active',
    });
    globalThis.fetch = fetchMock as never;
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    clearMock.mockRejectedValue(new Error('no native bridge'));
    const screen = await render(
      <AuthProvider><Probe /></AuthProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByTestId('state').element().textContent).toBe('Alice');
    });
    (screen.getByTestId('logout').element() as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId('state').element().textContent).toBe('(none)');
    });
    expect(clearMock).toHaveBeenCalled();
    // Let the swallowed rejection settle through its catch arm.
    await new Promise((r) => setTimeout(r, 50));
  });
});
