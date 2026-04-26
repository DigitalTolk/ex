import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('renders ChatPage shell when user is authenticated', async () => {
    // Default route is "/" which renders the protected ChatPage shell
    render(<App />);
    // After auth resolves, the empty <Route index> should show its message
    await vi.waitFor(() => {
      expect(
        screen.getByText(/select a channel or conversation to start chatting/i),
      ).toBeInTheDocument();
    });
  });
});
