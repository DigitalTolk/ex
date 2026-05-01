import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import App from './App';

const originalFetch = globalThis.fetch;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

describe('App - authenticated route', () => {
  beforeEach(() => {
    // First call: refresh returns access token
    // Subsequent calls: /api/v1/users/me returns user
    // Route by URL so fetch order can change without breaking the test.
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/auth/token/refresh')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ accessToken: 'tok' }),
        } as Response);
      }
      if (u.includes('/users/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({
            id: 'u-1',
            email: 'a@b.c',
            displayName: 'Alice',
            systemRole: 'admin',
            status: 'active',
          }),
        } as Response);
      }
      if (u.includes('/api/v1/version')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ version: 'test' }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve([]),
      } as Response);
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('redirects "/" to the general channel when user is authenticated', async () => {
    // Root visit lands on the index route which navigates to
    // /channel/general — confirms the post-login redirect.
    render(<App />);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/channel/general');
    });
  });
});
