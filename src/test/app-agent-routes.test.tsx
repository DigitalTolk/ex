import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

const originalFetch = globalThis.fetch;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

// Same shape as App.lazy-routes.test.tsx, for the three agent-feature routes:
// what's under test is App's lazy() thunk for each page, so the pages are
// stubbed and the route drives the chunk resolution.
vi.mock('@/pages/ChatPage', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});
vi.mock('@/pages/AgentsPage', () => ({ default: () => <div data-testid="stub-AgentsPage" /> }));
vi.mock('@/pages/SkillsPage', () => ({ default: () => <div data-testid="stub-SkillsPage" /> }));
vi.mock('@/pages/ConnectorsPage', () => ({ default: () => <div data-testid="stub-ConnectorsPage" /> }));

describe('App — agent feature lazy routes', () => {
  beforeEach(() => {
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

  it.each([
    ['/agents', 'stub-AgentsPage'],
    ['/skills', 'stub-SkillsPage'],
    ['/connectors', 'stub-ConnectorsPage'],
  ])('resolves the %s chunk', async (path, stub) => {
    window.history.pushState({}, '', path);
    const view = render(<App />);
    expect(await screen.findByTestId(stub, {}, { timeout: 15000 })).toBeInTheDocument();
    view.unmount();
  });
});
