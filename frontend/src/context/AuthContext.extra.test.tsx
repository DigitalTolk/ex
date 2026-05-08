import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext';

const originalFetch = globalThis.fetch;

function installOneSignalPlugin() {
  const oneSignal = {
    login: vi.fn().mockResolvedValue(undefined),
    addTags: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    removeTags: vi.fn().mockResolvedValue(undefined),
  };
  window.Capacitor = {
    Plugins: {
      OneSignalCapacitor: oneSignal,
    },
  };
  return oneSignal;
}

function AuthTestConsumer() {
  const { isAuthenticated, isLoading, user, logout, setAuth } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="user-name">{user?.displayName ?? 'none'}</span>
      <button onClick={() => setAuth('tok-123', {
        id: 'u-1',
        email: 'test@test.com',
        displayName: 'Test User',
        systemRole: 'member',
        status: 'active',
      })}>Set Auth</button>
      <button onClick={logout}>Logout</button>
    </div>
  );
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>{ui}</AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('AuthContext - setAuth', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete window.Capacitor;
  });

  it('setAuth sets user and makes authenticated true', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await user.click(screen.getByText('Set Auth'));

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Test User');
  });

  it('identifies the mobile OneSignal user after login state is set', async () => {
    const oneSignal = installOneSignalPlugin();
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await user.click(screen.getByText('Set Auth'));

    await waitFor(() => {
      expect(oneSignal.login).toHaveBeenCalledWith({ externalId: 'u-1' });
    });
    expect(oneSignal.addTags).toHaveBeenCalledWith({
      tags: {
        app: 'ex-mobile',
        server_url: window.location.origin,
        user_id: 'u-1',
      },
    });
  });

  it('does not identify push users in normal desktop browsers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await user.click(screen.getByText('Set Auth'));

    expect(window.Capacitor).toBeUndefined();
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
  });

});

describe('AuthContext - logout', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete window.Capacitor;
  });

  it('logout clears user and sets authenticated to false', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    // First set auth to have a user
    await user.click(screen.getByText('Set Auth'));
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');

    // Now logout
    await user.click(screen.getByText('Logout'));

    await waitFor(() => {
      expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    });
    expect(screen.getByTestId('user-name')).toHaveTextContent('none');
  });

  it('clears the mobile OneSignal identity on explicit logout', async () => {
    const oneSignal = installOneSignalPlugin();
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await user.click(screen.getByText('Set Auth'));
    await waitFor(() => {
      expect(oneSignal.login).toHaveBeenCalledWith({ externalId: 'u-1' });
    });

    await user.click(screen.getByText('Logout'));

    await waitFor(() => {
      expect(oneSignal.logout).toHaveBeenCalledTimes(1);
    });
    expect(oneSignal.removeTags).toHaveBeenCalledWith({ keys: ['user_id'] });
  });
});

describe('AuthContext - successful restore', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete window.Capacitor;
  });

  it('restores user from refresh token on mount', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'tok-refreshed' }),
      } as Response);

    // We also need to mock apiFetch for /api/v1/users/me
    // Since AuthProvider uses apiFetch internally after getting the token,
    // and apiFetch uses globalThis.fetch, we chain:
    // First call: /auth/token/refresh -> returns token
    // Second call: /api/v1/users/me -> returns user
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'u-1',
          email: 'restored@test.com',
          displayName: 'Restored User',
          systemRole: 'admin',
          status: 'active',
        }),
      } as Response);

    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Restored User');
  });

  it('identifies the mobile OneSignal user after restoring an existing session', async () => {
    const oneSignal = installOneSignalPlugin();
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'tok-refreshed' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'u-restored',
          email: 'restored@test.com',
          displayName: 'Restored User',
          systemRole: 'admin',
          status: 'active',
        }),
      } as Response);

    renderWithProviders(<AuthTestConsumer />);

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await waitFor(() => {
      expect(oneSignal.login).toHaveBeenCalledWith({ externalId: 'u-restored' });
    });
    expect(oneSignal.addTags).toHaveBeenCalledWith({
      tags: {
        app: 'ex-mobile',
        server_url: window.location.origin,
        user_id: 'u-restored',
      },
    });
  });
});

describe('AuthContext - useAuth throws outside provider', () => {
  it('throws when used outside AuthProvider', () => {
    // Suppress console.error for expected error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    function BadConsumer() {
      useAuth();
      return <div />;
    }

    expect(() => render(<BadConsumer />)).toThrow(
      'useAuth must be used within an AuthProvider',
    );

    consoleSpy.mockRestore();
  });
});
