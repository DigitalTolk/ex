import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext';

const originalFetch = globalThis.fetch;

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
  });

  it('setAuth sets user and makes authenticated true', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    await user.click(screen.getByText('Set Auth'));

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Test User');
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
  });

  it('logout clears user and sets authenticated to false', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AuthTestConsumer />);

    await vi.waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    // First set auth to have a user
    await user.click(screen.getByText('Set Auth'));
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');

    // Now logout
    await user.click(screen.getByText('Logout'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    });
    expect(screen.getByTestId('user-name')).toHaveTextContent('none');
  });
});

describe('AuthContext - successful restore', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
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

    await vi.waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('user-name')).toHaveTextContent('Restored User');
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
