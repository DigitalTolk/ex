import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './AuthContext';

// Mock fetch globally so the AuthProvider's tryRestore doesn't hit the network
const originalFetch = globalThis.fetch;

function AuthTestConsumer() {
  const { isAuthenticated, isLoading, login } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <button onClick={login}>Login</button>
    </div>
  );
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>{ui}</AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    // The AuthProvider calls fetch('/auth/token/refresh') on mount.
    // Return a non-ok response so the user stays unauthenticated.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders children', async () => {
    renderWithProviders(<div data-testid="child">hello</div>);
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('provides isAuthenticated: false initially (after loading)', async () => {
    renderWithProviders(<AuthTestConsumer />);

    // Wait for the tryRestore effect to complete
    await vi.waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
  });

  it('login redirects to OIDC', async () => {
    // Mock window.location.href setter
    const hrefSetter = vi.fn();
    const originalLocation = window.location;

    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, href: originalLocation.href },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window.location, 'href', {
      set: hrefSetter,
      get: () => originalLocation.href,
      configurable: true,
    });

    renderWithProviders(<AuthTestConsumer />);

    // Wait for loading to finish
    await vi.waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
    });

    act(() => {
      screen.getByText('Login').click();
    });

    expect(hrefSetter).toHaveBeenCalledWith('/auth/oidc/login');

    // Restore
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });
});
