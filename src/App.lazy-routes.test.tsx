import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

const originalFetch = globalThis.fetch;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

// The cold pages are code-split via React.lazy; this suite proves each route
// actually resolves its chunk and renders. The pages themselves are stubbed
// (each has its own dedicated suite) — what's under test here is App's route
// table + lazy wiring, so the stubs keep the render cheap and warning-free.
vi.mock('@/pages/ChatPage', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});
vi.mock('@/pages/DirectoriesPage', () => ({ default: () => <div data-testid="stub-DirectoriesPage" /> }));
vi.mock('@/pages/AdminPage', () => ({ default: () => <div data-testid="stub-AdminPage" /> }));
vi.mock('@/pages/IncomingWebhooksPage', () => ({ default: () => <div data-testid="stub-IncomingWebhooksPage" /> }));
vi.mock('@/pages/BotsPage', () => ({ default: () => <div data-testid="stub-BotsPage" /> }));
vi.mock('@/pages/CustomEmojiPage', () => ({ default: () => <div data-testid="stub-CustomEmojiPage" /> }));
vi.mock('@/pages/NewConversationPage', () => ({ default: () => <div data-testid="stub-NewConversationPage" /> }));
vi.mock('@/pages/ThreadsPage', () => ({ default: () => <div data-testid="stub-ThreadsPage" /> }));
vi.mock('@/pages/DraftsPage', () => ({ default: () => <div data-testid="stub-DraftsPage" /> }));
vi.mock('@/pages/ActivityPage', () => ({ default: () => <div data-testid="stub-ActivityPage" /> }));
vi.mock('@/pages/SearchResultsPage', () => ({ default: () => <div data-testid="stub-SearchResultsPage" /> }));
vi.mock('@/pages/NotFoundPage', () => ({ NotFoundPage: () => <div data-testid="stub-NotFoundPage" /> }));

describe('App — lazy cold routes', () => {
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

  it('resolves and renders every code-split route', async () => {
    const routes: Array<[path: string, stub: string]> = [
      ['/directory/channels', 'stub-DirectoriesPage'],
      ['/search', 'stub-SearchResultsPage'],
      ['/activity', 'stub-ActivityPage'],
      ['/threads', 'stub-ThreadsPage'],
      ['/drafts', 'stub-DraftsPage'],
      ['/admin', 'stub-AdminPage'],
      ['/webhooks', 'stub-IncomingWebhooksPage'],
      ['/bots', 'stub-BotsPage'],
      ['/emojis', 'stub-CustomEmojiPage'],
      ['/conversations/new', 'stub-NewConversationPage'],
      ['/no-such-page', 'stub-NotFoundPage'],
    ];
    for (const [path, stub] of routes) {
      window.history.replaceState({}, '', path);
      const { unmount } = render(<App />);
      expect(await screen.findByTestId(stub)).toBeInTheDocument();
      unmount();
    }
  });
});
