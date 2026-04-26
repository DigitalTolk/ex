import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    // Initially shows Loading... from ProtectedRoute, then redirects to login
    await vi.waitFor(() => {
      // After auth finishes loading, unauthenticated user sees login page
      expect(
        screen.getByText('Welcome back') || screen.getByText('Loading...'),
      ).toBeInTheDocument();
    });
  });

  it('redirects unauthenticated user to login page', async () => {
    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByText('Welcome back')).toBeInTheDocument();
    });
  });

  it('shows sign in with SSO button on login page', async () => {
    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText('Sign in with Single Sign-On')).toBeInTheDocument();
    });
  });
});
