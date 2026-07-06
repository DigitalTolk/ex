import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import App from './App';

const originalFetch = globalThis.fetch;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

describe('App', () => {
  beforeEach(() => {
    // AuthProvider calls fetch('/auth/token/refresh') on mount
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('renders without crashing', async () => {
    render(<App />);
    expect(screen.getByTestId('app-auth-loading')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).toBeNull();
    await waitFor(() => {
      // After auth finishes loading, unauthenticated user sees login page
      expect(screen.getByText('Welcome back')).toBeInTheDocument();
    });
  });

  it('redirects unauthenticated user to login page', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('Welcome back')).toBeInTheDocument();
    });
  });

  it('shows sign in with SSO button on login page', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByLabelText('Sign in with Single Sign-On')).toBeInTheDocument();
    });
  });

  it('shows a connecting indicator and a sign-in escape hatch while the auth restore hangs', async () => {
    // Regression for the blank-screen-on-open bug: a boot restore request
    // that never settles used to render a completely empty page forever.
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(
        () => new Promise(() => {}), // request never settles
      ) as unknown as typeof fetch;
      // Earlier tests in this file leave jsdom parked on /login; the boot
      // screen only exists behind ProtectedRoute at a protected path.
      window.history.replaceState({}, '', '/');
      render(<App />);

      const loading = screen.getByTestId('app-auth-loading');
      expect(loading).toHaveTextContent('Connecting');
      expect(screen.queryByTestId('app-auth-loading-slow')).toBeNull();

      // Past the slow-connect threshold the screen admits the delay and
      // offers a way out instead of an indefinite spinner.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByTestId('app-auth-loading-slow')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to sign-in' })).toHaveAttribute('href', '/login');
    } finally {
      vi.useRealTimers();
    }
  });
});
