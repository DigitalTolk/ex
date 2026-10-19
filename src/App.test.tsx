import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import App from './App';

const originalFetch = globalThis.fetch;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

describe('App', () => {
  beforeEach(() => {
    // jsdom keeps the URL between tests, and a test that ends on /login would
    // skip the next one's boot screen: each starts at a protected path.
    window.history.replaceState({}, '', '/');
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
    // Generous timeout: auth restore + route render can lag under
    // full-suite saturation in the merged multi-project run.
    await waitFor(() => {
      // After auth finishes loading, unauthenticated user sees login page
      expect(screen.getByText('Welcome back')).toBeInTheDocument();
    }, { timeout: 10000 });
  });

  it('dismisses the index.html boot splash on first commit', async () => {
    // index.html paints this splash before the bundle executes; React must
    // remove it as soon as the app renders so the in-app loading states
    // (AuthLoadingScreen) own the screen from there on.
    const splash = document.createElement('div');
    splash.id = 'boot-splash';
    document.body.appendChild(splash);

    render(<App />);

    await waitFor(() => {
      expect(document.getElementById('boot-splash')).toBeNull();
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
    const hanging: Array<(reason: Error) => void> = [];
    try {
      globalThis.fetch = vi.fn(
        // The request never settles (and, unlike a real one, ignores its
        // abort signal) until the test ends.
        () => new Promise((_resolve, reject) => hanging.push(reject)),
      ) as unknown as typeof fetch;
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
      // The refresh is single-flight across the module: left hanging, every
      // later test in this file waited on it (seen in a shuffled run).
      await act(async () => {
        for (const reject of hanging) reject(new TypeError('Failed to fetch'));
      });
      vi.useRealTimers();
    }
  });
});
